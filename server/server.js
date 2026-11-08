#!/usr/bin/env node
/**
 * TalantaTix Kenya – standalone ticketing server (zero dependencies).
 * Serves index.html + a complete JSON API backed by data.json.
 *
 *   node server.js          → http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Implements the same rules as the main Next.js system:
 *   • prices are ALWAYS computed server-side from data.json (never trusted from the browser)
 *   • temporary seat holds with configurable TTL, auto-released on expiry
 *   • tickets are only issued after successful payment; seats then become SOLD
 *   • staff scan validates ticket state and marks tickets USED exactly once
 *   • stadium structure (stands/levels/phases/sections/blocks/rows/seats) is
 *     fully DB-driven (data.json here) and editable via the admin API
 */
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 3000)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json')
const INDEX_FILE = path.join(__dirname, 'index.html')

// ---------------------------------------------------------------- utilities
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`
const nowIso = () => new Date().toISOString()
const pad3 = (n) => String(n).padStart(3, '0')
const money = (n) => Math.round(n * 100) / 100

// ---------------------------------------------------------------- data store
let DATA = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
let saveTimer = null

function save() {
  // debounced atomic write (tmp file + rename)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(DATA))
    fs.renameSync(tmp, DATA_FILE)
  }, 120)
  process.on('SIGINT', () => {
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(DATA)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE) } catch (_) {}
    process.exit(0)
  })
}
// ensure immediate durability on exit
process.on('SIGTERM', () => {
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(DATA)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE) } catch (_) {}
  process.exit(0)
})

const S = () => DATA.settings

// ---------------------------------------------------------------- seat model
// Seats are virtual & deterministic:  sec_<num>:<blockIdx>:<rowLabel>:<seatNum>
function sectionById(sid) { return DATA.sections.find((s) => s.id === sid) }
function levelById(lid) { return DATA.levels.find((l) => l.id === lid) }
function standById(sid) { return DATA.stands.find((s) => s.id === sid) }
function phaseById(pid) { return DATA.phases.find((p) => p.id === pid) }
function categoryById(cid) { return DATA.categories.find((c) => c.id === cid) }

function blockName(section, blockIdx) {
  const prefix = section.premium ? 'VIP-' : section.num + '-'
  return prefix + String.fromCharCode(65 + blockIdx)
}
function sectionSeatIds(section) {
  const lvl = levelById(section.levelId)
  const rpb = section.rowsPerBlock || lvl.rowsPerBlock
  const spr = section.seatsPerRow || lvl.seatsPerRow
  const out = []
  for (let b = 0; b < section.blockCount; b++)
    for (let r = 0; r < rpb; r++)
      for (let n = 1; n <= spr; n++)
        out.push(`${section.id}:${b}:${String.fromCharCode(65 + r)}:${pad3(n)}`)
  return out
}
function seatLabel(seatId) {
  const [secId, b, row, num] = seatId.split(':')
  const sec = sectionById(secId)
  if (!sec) return seatId
  const stand = standById(sec.standId)
  const level = levelById(sec.levelId)
  const phase = phaseById(sec.phaseId)
  return [
    `Stand: ${stand ? stand.name : sec.standId}`,
    `Level: ${level ? level.shortName : sec.levelId}`,
    `Phase: ${phase ? phase.name : sec.phaseId}`,
    `Section: ${sec.num}`,
    `Block: ${blockName(sec, Number(b))}`,
    `Row: ${row}`,
    `Seat: ${num}`,
  ].join(' · ')
}
function seatParts(seatId) {
  const [secId, b, row, num] = seatId.split(':')
  const sec = sectionById(secId)
  return {
    sectionId: secId, sectionNum: sec ? sec.num : null, sectionName: sec ? sec.name : secId,
    blockName: sec ? blockName(sec, Number(b)) : b, row, seat: num,
  }
}

// ------------------------------------------------------- availability & holds
function evAvail(eventId) {
  if (!DATA.availability[eventId]) DATA.availability[eventId] = {}
  return DATA.availability[eventId]
}
function seatState(eventId, seatId) {
  const rec = evAvail(eventId)[seatId]
  return rec ? rec.s : 'AVAILABLE'
}
function sweepExpired() {
  const now = Date.now()
  // expire holds
  for (const hid of Object.keys(DATA.holds)) {
    const h = DATA.holds[hid]
    if (h.status === 'ACTIVE' && new Date(h.expiresAt).getTime() < now) {
      h.status = 'EXPIRED'
      const av = evAvail(h.eventId)
      for (const seatId of h.seatIds) {
        const rec = av[seatId]
        if (rec && rec.s === 'HELD' && rec.h === hid) delete av[seatId]
      }
    }
  }
  // expire pending orders past their payment window
  let dirty = false
  for (const o of DATA.orders) {
    if (o.status === 'PENDING' && o.holdExpiresAt && new Date(o.holdExpiresAt).getTime() < now) {
      o.status = 'EXPIRED'
      const av = evAvail(o.eventId)
      for (const it of o.items) {
        const rec = av[it.seatId]
        if (rec && rec.s === 'HELD' && rec.o === o.id) delete av[it.seatId]
      }
      dirty = true
    }
  }
  if (dirty) save()
}
setInterval(sweepExpired, 10_000).unref()

// ---------------------------------------------------------------- pricing
// Server-side only. A category is sellable in a section ONLY when an explicit
// section price exists (same contract as the main system) — never trust the browser.
function resolveUnitPrice(section, categoryId) {
  const p = section.prices ? section.prices[categoryId] : undefined
  if (p !== undefined && p !== null) return money(p)
  return null
}
function sellableCategories(section) {
  const cats = []
  for (const cat of DATA.categories) {
    if (!cat.active) continue
    const price = resolveUnitPrice(section, cat.id)
    if (price !== null) cats.push({ id: cat.id, name: cat.name, color: cat.color, price })
  }
  return cats
}
function evaluatePromo(code, subtotal) {
  if (!code) return null
  const promo = DATA.promos.find((p) => p.code === String(code).trim().toUpperCase() && p.active)
  if (!promo) return null
  if (promo.minAmount && subtotal < promo.minAmount) return null
  let discount = promo.type === 'PERCENT' ? (subtotal * promo.value) / 100 : promo.value
  discount = Math.min(money(discount), subtotal)
  return { code: promo.code, discount: money(discount) }
}

// ---------------------------------------------------------------- http helpers
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  })
  res.end(body)
}
const err = (res, code, message, extra) => json(res, code, Object.assign({ ok: false, error: message }, extra || {}))
const ok = (res, data) => json(res, 200, { ok: true, data })

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy() })
    req.on('end', () => {
      if (!buf) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('Invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- auth (demo)
const adminSessions = new Map() // token → userId
function login(email, password) {
  const user = DATA.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase())
  if (!user || user.passwordHash !== sha256(password || '')) return null
  const token = sha256(user.id + ':' + crypto.randomBytes(16).toString('hex'))
  adminSessions.set(token, user.id)
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }
}
function userFromToken(token) {
  const uid = adminSessions.get(String(token || '').replace(/^Bearer\s+/i, ''))
  return uid ? DATA.users.find((u) => u.id === uid) : null
}

// ---------------------------------------------------------------- core: hold
function holdSeats(session, eventId, items) {
  sweepExpired()
  const event = DATA.events.find((e) => e.id === eventId)
  if (!event || event.status !== 'PUBLISHED') throw httpErr(400, 'Event is not open for booking')

  const requests = []
  for (const it of items || []) for (const seatId of it.seatIds || []) requests.push({ seatId, categoryId: it.categoryId })
  const seatIds = [...new Set(requests.map((r) => r.seatId))]
  if (!seatIds.length) throw httpErr(400, 'No seats selected')
  if (seatIds.length > S().maxSeatsPerOrder) throw httpErr(400, `Maximum ${S().maxSeatsPerOrder} seats per transaction`)

  // validate structure + phase + section + category + availability (atomic in-memory)
  const lines = []
  const av = evAvail(eventId)
  for (const req of requests) {
    const [secId, b, row, num] = req.seatId.split(':')
    const sec = sectionById(secId)
    if (!sec || !sec.active) throw httpErr(409, 'Seat is not on sale', { taken: [req.seatId] })
    const blockCount = sec.blockCount
    const lvl = levelById(sec.levelId)
    const rpb = sec.rowsPerBlock || lvl.rowsPerBlock
    const spr = sec.seatsPerRow || lvl.seatsPerRow
    const bi = Number(b)
    if (!(bi >= 0 && bi < blockCount)) throw httpErr(404, 'Seat not found', { taken: [req.seatId] })
    const rowIdx = row.charCodeAt(0) - 65
    if (!(rowIdx >= 0 && rowIdx < rpb)) throw httpErr(404, 'Seat not found', { taken: [req.seatId] })
    if (!(Number(num) >= 1 && Number(num) <= spr)) throw httpErr(404, 'Seat not found', { taken: [req.seatId] })

    const phase = phaseById(sec.phaseId)
    if (phase && (!phase.onSale)) throw httpErr(409, `${phase.name} is not open for sale yet`, { taken: [req.seatId] })

    const price = resolveUnitPrice(sec, req.categoryId)
    if (price === null) throw httpErr(409, `Selected ticket category is not sold in ${sec.name}`, { taken: [req.seatId] })

    const st = av[req.seatId] ? av[req.seatId].s : 'AVAILABLE'
    if (st !== 'AVAILABLE') throw httpErr(409, `Seat ${row}${num} in ${blockName(sec, bi)} is no longer available`, { taken: [req.seatId] })

    lines.push({ seatId: req.seatId, categoryId: req.categoryId, unitPrice: price, sectionId: sec.id })
  }

  const holdId = id('hld')
  const expiresAt = new Date(Date.now() + S().holdMinutes * 60_000).toISOString()
  DATA.holds[holdId] = { id: holdId, eventId, seatIds, session: session || null, status: 'ACTIVE', createdAt: nowIso(), expiresAt }
  for (const l of lines) {
    const [secId, b, row, num] = l.seatId.split(':')
    const sec = sectionById(secId)
    av[l.seatId] = { s: 'HELD', h: holdId, e: expiresAt }
    l.blockName = blockName(sec, Number(b)); l.row = row; l.seat = num
    l.sectionName = sec.name
  }
  // persist the chosen categories so order creation can recompute prices server-side
  DATA.holds[holdId].lines = lines.map((l) => ({ seatId: l.seatId, categoryId: l.categoryId }))
  const subtotal = money(lines.reduce((a, l) => a + l.unitPrice, 0))
  save()
  return { holdId, expiresAt, lines, subtotal }
}
function releaseHold(hold, status) {
  hold.status = status || 'RELEASED'
  const av = evAvail(hold.eventId)
  for (const seatId of hold.seatIds) {
    const rec = av[seatId]
    if (rec && rec.s === 'HELD' && rec.h === hold.id) delete av[seatId]
  }
}
function httpErr(status, message, extra) {
  const e = new Error(message); e.status = status; e.extra = extra; return e
}

// ---------------------------------------------------------------- core: order
function createOrder(holdId, contact, promoCode) {
  sweepExpired()
  const hold = DATA.holds[holdId]
  if (!hold || hold.status !== 'ACTIVE') throw httpErr(400, 'Your seat hold has expired — please select seats again')
  const event = DATA.events.find((e) => e.id === hold.eventId)
  if (!event || event.status !== 'PUBLISHED') throw httpErr(400, 'Event is not open for booking')
  if (!contact || !contact.name || !contact.phone) throw httpErr(400, 'Name and phone number are required')

  // re-verify availability + recompute ALL prices server-side
  const av = evAvail(hold.eventId)
  let subtotal = 0
  const items = hold.seatIds.map((seatId) => {
    const rec = av[seatId]
    if (!rec || rec.s !== 'HELD' || rec.h !== hold.id) throw httpErr(409, 'Some of your held seats were released — please start again')
    const [secId, b, row, num] = seatId.split(':')
    const sec = sectionById(secId)
    const line = hold.lines.find((l) => l.seatId === seatId)
    const price = resolveUnitPrice(sec, line.categoryId) // server-side price, never from browser
    subtotal += price
    return { seatId, sectionId: sec.id, sectionName: sec.name, blockName: blockName(sec, Number(b)), row, seat: num, categoryId: line.categoryId, unitPrice: price }
  })
  subtotal = money(subtotal)
  const promo = evaluatePromo(promoCode, subtotal)
  const discount = promo ? promo.discount : 0

  const order = {
    id: id('ord'),
    number: `TTX-${(DATA.counters.order++).toString(36).toUpperCase()}${Math.floor(Math.random() * 90 + 10)}`,
    eventId: hold.eventId,
    status: 'PENDING',
    contact: { name: contact.name, email: contact.email || '', phone: contact.phone },
    items,
    subtotal,
    discount,
    total: money(subtotal - discount),
    promo: promo ? promo.code : null,
    holdExpiresAt: hold.expiresAt,
    createdAt: nowIso(),
    paidAt: null,
    payment: null,
  }
  DATA.orders.push(order)
  // transfer hold ownership → order (keeps seats locked for the payment window)
  for (const it of items) av[it.seatId] = { s: 'HELD', o: order.id, e: hold.expiresAt }
  hold.status = 'CONVERTED'
  if (promo) { const p = DATA.promos.find((x) => x.code === promo.code); if (p) p.usedCount = (p.usedCount || 0) + 1 }
  save()
  return order
}

function payOrder(orderNumber, method) {
  sweepExpired()
  const order = DATA.orders.find((o) => o.number === orderNumber)
  if (!order) throw httpErr(404, 'Order not found')
  if (order.status === 'PAID') throw httpErr(409, 'Order is already paid')
  if (order.status !== 'PENDING') throw httpErr(409, 'Order payment window has expired — please book again')
  if (!['MPESA', 'CARD'].includes(method)) throw httpErr(400, 'Invalid payment method')
  const enabled = method === 'MPESA' ? S().mpesaEnabled : S().cardEnabled
  if (!enabled) throw httpErr(400, `${method} payments are currently disabled`)

  // simulated gateway – always succeeds (paymentMode=simulation)
  order.payment = {
    method,
    status: 'SUCCESSFUL',
    amount: order.total,
    reference: method === 'MPESA' ? 'Q' + crypto.randomBytes(5).toString('hex').toUpperCase() : null,
    cardLast4: method === 'CARD' ? '4242' : null,
    at: nowIso(),
  }
  order.status = 'PAID'
  order.paidAt = nowIso()
  const av = evAvail(order.eventId)
  const event = DATA.events.find((e) => e.id === order.eventId)
  const tickets = order.items.map((it) => {
    av[it.seatId] = { s: 'SOLD', o: order.id }
    const cat = categoryById(it.categoryId)
    DATA.counters.ticket++
    const code = `TTX-TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}${DATA.counters.ticket}`
    const ticket = {
      code,
      orderId: order.id,
      orderNumber: order.number,
      eventId: order.eventId,
      eventName: event ? event.name : order.eventId,
      eventDate: event ? event.date : null,
      venue: event ? event.venue : S().venueName,
      seatId: it.seatId,
      categoryId: it.categoryId,
      categoryName: cat ? cat.name : it.categoryId,
      unitPrice: it.unitPrice,
      holderName: order.contact.name,
      seatLabel: `${it.sectionName} · ${it.blockName} · Row ${it.row} · Seat ${it.seat}`,
      status: 'VALID',
      usedAt: null,
      usedBy: null,
      createdAt: nowIso(),
    }
    DATA.tickets.push(ticket)
    return ticket
  })
  save()
  return { order, tickets }
}

// ---------------------------------------------------------------- core: scan
function scanTicket(code, staffUser) {
  const codeNorm = String(code || '').trim().toUpperCase()
  if (!codeNorm) throw httpErr(400, 'Ticket code is required')
  const ticket = DATA.tickets.find((t) => t.code === codeNorm || t.code === codeNorm.replace(/^TTX\+/, 'TTX-TKT-'))
  const log = (result, reason, extra) => {
    DATA.scans.unshift({ at: nowIso(), code: codeNorm, result, reason: reason || null, by: staffUser ? staffUser.email : 'staff' })
    if (DATA.scans.length > 500) DATA.scans.length = 500
    save()
    return Object.assign({ result, reason, ticket: ticket || null }, extra || {})
  }
  if (!ticket) return log('REJECTED', 'NOT_FOUND')
  if (ticket.status === 'USED') {
    return log('REJECTED', 'ALREADY_USED', { usedAt: ticket.usedAt, usedBy: ticket.usedBy })
  }
  const order = DATA.orders.find((o) => o.id === ticket.orderId)
  if (!order || order.status !== 'PAID') return log('REJECTED', 'UNPAID')
  if (order.status === 'CANCELLED') return log('REJECTED', 'CANCELLED')
  // mark used exactly once
  ticket.status = 'USED'
  ticket.usedAt = nowIso()
  ticket.usedBy = staffUser ? staffUser.email : 'staff'
  return log('ACCEPTED', null, {
    holder: ticket.holderName,
    seat: ticket.seatLabel,
    event: ticket.eventName,
    categoryName: ticket.categoryName,
  })
}

// ---------------------------------------------------------------- public payloads
function eventSummary(e) {
  const av = evAvail(e.id)
  let minPrice = Infinity
  for (const sec of DATA.sections) {
    if (!sec.active) continue
    for (const cid of Object.keys(sec.prices || {})) minPrice = Math.min(minPrice, resolveUnitPrice(sec, cid))
  }
  const sold = Object.values(av).filter((r) => r.s === 'SOLD').length
  return {
    id: e.id, name: e.name, category: e.category, description: e.description, venue: e.venue,
    date: e.date, status: e.status, featured: e.featured,
    fromPrice: isFinite(minPrice) ? minPrice : null,
    seatsSold: sold,
  }
}
function stadiumMap(eventId) {
  sweepExpired()
  const av = evAvail(eventId)
  const counts = {} // seatId → state, aggregated per section
  const agg = {}
  for (const [seatId, rec] of Object.entries(av)) {
    const secId = seatId.split(':')[0]
    agg[secId] = agg[secId] || { total: 0, taken: 0 }
    agg[secId].total++
    if (rec.s !== 'AVAILABLE') agg[secId].taken++
  }
  const sections = DATA.sections.map((sec) => {
    const lvl = levelById(sec.levelId)
    const rpb = sec.rowsPerBlock || lvl.rowsPerBlock
    const spr = sec.seatsPerRow || lvl.seatsPerRow
    const total = sec.blockCount * rpb * spr
    const taken = agg[sec.id] ? agg[sec.id].taken : 0
    const phase = phaseById(sec.phaseId)
    return {
      id: sec.id, num: sec.num, name: sec.name, standId: sec.standId, levelId: sec.levelId,
      phaseId: sec.phaseId, premium: !!sec.premium, active: sec.active,
      phaseOnSale: phase ? phase.onSale : true,
      map: sec.map, total, taken, available: sec.active ? total - taken : 0,
      categories: sec.active ? sellableCategories(sec) : [],
    }
  })
  return {
    event: eventSummary(DATA.events.find((e) => e.id === eventId)),
    stands: DATA.stands, levels: DATA.levels, phases: DATA.phases,
    categories: DATA.categories.filter((c) => c.active),
    sections,
  }
}
function sectionSeats(eventId, sectionId) {
  sweepExpired()
  const sec = sectionById(sectionId)
  if (!sec) throw httpErr(404, 'Section not found')
  const lvl = levelById(sec.levelId)
  const rpb = sec.rowsPerBlock || lvl.rowsPerBlock
  const spr = sec.seatsPerRow || lvl.seatsPerRow
  const av = evAvail(eventId)
  const blocks = []
  for (let b = 0; b < sec.blockCount; b++) {
    const rows = []
    for (let r = 0; r < rpb; r++) {
      const label = String.fromCharCode(65 + r)
      const seats = []
      for (let n = 1; n <= spr; n++) {
        const seatId = `${sec.id}:${b}:${label}:${pad3(n)}`
        const rec = av[seatId]
        seats.push({ id: seatId, n, s: rec ? rec.s : 'AVAILABLE', note: rec ? rec.note || null : null })
      }
      rows.push({ label, seats })
    }
    blocks.push({ name: blockName(sec, b), rows })
  }
  return {
    section: { id: sec.id, name: sec.name, num: sec.num, standId: sec.standId, levelId: sec.levelId, phaseId: sec.phaseId, premium: !!sec.premium, active: sec.active },
    categories: sellableCategories(sec),
    blocks,
  }
}

// ---------------------------------------------------------------- admin payloads
function requireAdmin(req) {
  const user = userFromToken(req.headers.authorization)
  if (!user || user.role !== 'ADMIN') throw httpErr(401, 'Admin authentication required')
  return user
}
function adminOverview() {
  sweepExpired()
  const paid = DATA.orders.filter((o) => o.status === 'PAID')
  const revenue = paid.reduce((a, o) => a + o.total, 0)
  const perEvent = DATA.events.map((e) => {
    const av = evAvail(e.id)
    let total = 0, sold = 0
    for (const sec of DATA.sections) {
      if (!sec.active) continue
      const lvl = levelById(sec.levelId)
      total += sec.blockCount * (sec.rowsPerBlock || lvl.rowsPerBlock) * (sec.seatsPerRow || lvl.seatsPerRow)
    }
    for (const rec of Object.values(av)) if (rec.s === 'SOLD') sold++
    const evOrders = paid.filter((o) => o.eventId === e.id)
    return {
      eventId: e.id, name: e.name, date: e.date, capacity: total, sold,
      occupancy: total ? Math.round((sold / total) * 1000) / 10 : 0,
      revenue: evOrders.reduce((a, o) => a + o.total, 0), orders: evOrders.length,
    }
  })
  const byCategory = {}
  for (const t of DATA.tickets) {
    byCategory[t.categoryName] = byCategory[t.categoryName] || { tickets: 0, revenue: 0 }
    byCategory[t.categoryName].tickets++
    byCategory[t.categoryName].revenue += t.unitPrice
  }
  return {
    revenue: money(revenue),
    orders: { paid: paid.length, pending: DATA.orders.filter((o) => o.status === 'PENDING').length, expired: DATA.orders.filter((o) => o.status === 'EXPIRED').length },
    ticketsSold: DATA.tickets.length,
    ticketsUsed: DATA.tickets.filter((t) => t.status === 'USED').length,
    activeHolds: Object.values(DATA.holds).filter((h) => h.status === 'ACTIVE').length,
    perEvent, byCategory,
    recentOrders: DATA.orders.slice(-8).reverse().map((o) => ({ number: o.number, contact: o.contact.name, total: o.total, status: o.status, createdAt: o.createdAt, eventId: o.eventId })),
    recentScans: DATA.scans.slice(0, 8),
  }
}

// ---------------------------------------------------------------- router
const routes = []
function route(method, pattern, handler) {
  const keys = []
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)' }) + '$')
  routes.push({ method, rx, keys, handler })
}

// ---- public ----
route('GET', '/api/health', (ctx) => ok(ctx.res, { status: 'up', time: nowIso(), system: 'TalantaTix Standalone' }))
route('GET', '/api/bootstrap', (ctx) => ok(ctx.res, {
  settings: { venueName: S().venueName, siteTagline: S().siteTagline, supportEmail: S().supportEmail, holdMinutes: S().holdMinutes, maxSeatsPerOrder: S().maxSeatsPerOrder, mpesaEnabled: S().mpesaEnabled, cardEnabled: S().cardEnabled },
  categories: DATA.categories.filter((c) => c.active),
}))
route('GET', '/api/events', (ctx) => ok(ctx.res, DATA.events.filter((e) => e.status === 'PUBLISHED').map(eventSummary)))
route('GET', '/api/events/:id/map', (ctx) => ok(ctx.res, stadiumMap(ctx.params.id)))
route('GET', '/api/events/:id/sections/:sectionId/seats', (ctx) => ok(ctx.res, sectionSeats(ctx.params.id, ctx.params.sectionId)))
route('POST', '/api/quote', async (ctx) => {
  const { eventId, items } = ctx.body
  sweepExpired()
  const av = evAvail(eventId)
  const lines = []
  let subtotal = 0
  for (const it of items || []) {
    for (const seatId of it.seatIds || []) {
      const [secId] = seatId.split(':')
      const sec = sectionById(secId)
      if (!sec) throw httpErr(404, 'Section not found')
      const price = resolveUnitPrice(sec, it.categoryId)
      if (price === null) throw httpErr(409, `Category not sold in ${sec.name}`)
      const rec = av[seatId]
      const state = rec ? rec.s : 'AVAILABLE'
      subtotal += price
      lines.push({ seatId, categoryId: it.categoryId, unitPrice: price, state })
    }
  }
  ok(ctx.res, { lines, subtotal: money(subtotal), currency: 'KES' })
})
route('POST', '/api/holds', async (ctx) => {
  const { eventId, items, session } = ctx.body
  const result = holdSeats(session, eventId, items)
  ok(ctx.res, Object.assign({ currency: 'KES' }, result))
})
route('DELETE', '/api/holds/:id', (ctx) => {
  const hold = DATA.holds[ctx.params.id]
  if (hold && hold.status === 'ACTIVE') { releaseHold(hold); save() }
  ok(ctx.res, { released: true })
})
route('POST', '/api/orders', async (ctx) => {
  const order = createOrder(ctx.body.holdId, ctx.body.contact, ctx.body.promoCode)
  ok(ctx.res, { order: { id: order.id, number: order.number, status: order.status, subtotal: order.subtotal, discount: order.discount, total: order.total, holdExpiresAt: order.holdExpiresAt, items: order.items.length, eventId: order.eventId } })
})
route('GET', '/api/orders/:number', (ctx) => {
  const order = DATA.orders.find((o) => o.number === String(ctx.params.number).toUpperCase())
  if (!order) throw httpErr(404, 'Order not found')
  const tickets = DATA.tickets.filter((t) => t.orderId === order.id)
  const event = DATA.events.find((e) => e.id === order.eventId)
  ok(ctx.res, { order: { ...order }, event: event ? { name: event.name, date: event.date, venue: event.venue } : null, tickets })
})
route('POST', '/api/orders/:number/pay', async (ctx) => {
  const { order, tickets } = payOrder(ctx.params.number, ctx.body.method)
  ok(ctx.res, { order: { number: order.number, status: order.status, total: order.total, payment: order.payment }, tickets })
})
route('POST', '/api/scan', async (ctx) => {
  const user = userFromToken(ctx.req.headers.authorization) || (ctx.body && ctx.body.staffEmail ? DATA.users.find((u) => u.email === ctx.body.staffEmail && u.passwordHash === sha256(ctx.body.staffPassword || '')) : null)
  if (!user || (user.role !== 'STAFF' && user.role !== 'ADMIN')) throw httpErr(401, 'Staff authentication required')
  ok(ctx.res, scanTicket(ctx.body.code, user))
})
route('POST', '/api/staff/login', async (ctx) => ok(ctx.res, (() => {
  const user = DATA.users.find((u) => u.email.toLowerCase() === String(ctx.body.email || '').toLowerCase())
  if (!user || user.passwordHash !== sha256(ctx.body.password || '') || user.role === 'CUSTOMER') throw httpErr(401, 'Invalid staff credentials')
  const token = sha256(user.id + ':' + crypto.randomBytes(16).toString('hex'))
  adminSessions.set(token, user.id)
  return { token, user: { email: user.email, name: user.name, role: user.role } }
})()))

// ---- admin ----
route('POST', '/api/admin/login', async (ctx) => {
  const result = login(ctx.body.email, ctx.body.password)
  if (!result) throw httpErr(401, 'Invalid email or password')
  ok(ctx.res, result)
})
route('GET', '/api/admin/overview', (ctx) => { requireAdmin(ctx.req); ok(ctx.res, adminOverview()) })
route('GET', '/api/admin/promos', (ctx) => { requireAdmin(ctx.req); ok(ctx.res, { promos: DATA.promos }) })
route('GET', '/api/admin/stadium', (ctx) => {
  requireAdmin(ctx.req)
  ok(ctx.res, { stands: DATA.stands, levels: DATA.levels, phases: DATA.phases, sections: DATA.sections, categories: DATA.categories })
})
route('POST', '/api/admin/sections', async (ctx) => {
  requireAdmin(ctx.req)
  const b = ctx.body
  if (!b.standId || !b.levelId || !b.phaseId) throw httpErr(400, 'standId, levelId and phaseId are required')
  const stand = standById(b.standId), level = levelById(b.levelId), phase = phaseById(b.phaseId)
  if (!stand || !level || !phase) throw httpErr(400, 'Invalid stand/level/phase reference')
  let num = Number(b.num)
  if (!num || DATA.sections.some((s) => s.num === num)) throw httpErr(409, `Section number ${b.num} already exists or is invalid`)
  const blockCount = Math.max(1, Number(b.blockCount) || 3)
  const rpb = b.rowsPerBlock != null ? Math.max(1, Number(b.rowsPerBlock)) : null
  const spr = b.seatsPerRow != null ? Math.max(1, Number(b.seatsPerRow)) : null
  const prices = {}
  for (const [cid, price] of Object.entries(b.prices || {})) {
    if (price === null || price === '') continue
    if (!categoryById(cid)) throw httpErr(400, `Unknown category ${cid}`)
    prices[cid] = money(Number(price))
  }
  if (!Object.keys(prices).length) throw httpErr(400, 'At least one category price is required')
  const count = DATA.sections.filter((s) => s.standId === b.standId && s.levelId === b.levelId).length
  const sec = {
    id: `sec_${num}`, name: b.name || `Section ${num}`, num,
    standId: b.standId, levelId: b.levelId, phaseId: b.phaseId,
    blockCount, premium: !!b.premium, rowsPerBlock: rpb, seatsPerRow: spr,
    map: autoSectionRectJs(stand.side, level.sortOrder, count, count + 1),
    prices, active: b.active !== false,
  }
  DATA.sections.push(sec)
  save()
  ok(ctx.res, { section: sec })
})
route('PUT', '/api/admin/sections/:id', async (ctx) => {
  requireAdmin(ctx.req)
  const sec = sectionById(ctx.params.id)
  if (!sec) throw httpErr(404, 'Section not found')
  const b = ctx.body
  // capacity-affecting changes are blocked while seats are sold/held
  const capacityChanged = (b.blockCount != null && b.blockCount !== sec.blockCount) ||
    (b.rowsPerBlock != null && b.rowsPerBlock !== sec.rowsPerBlock) ||
    (b.seatsPerRow != null && b.seatsPerRow !== sec.seatsPerRow)
  if (capacityChanged) {
    const av = DATA.availability[Object.keys(DATA.availability).find((eid) => DATA.availability[eid]) || ''] || {}
    const inUse = Object.entries(DATA.availability).some(([, m]) => Object.keys(m).some((sid) => sid.startsWith(sec.id + ':')))
    if (inUse) throw httpErr(409, 'Cannot change seat layout while seats are sold or held in this section')
    if (b.blockCount != null) sec.blockCount = Math.max(1, Number(b.blockCount))
    if (b.rowsPerBlock != null) sec.rowsPerBlock = Math.max(1, Number(b.rowsPerBlock))
    if (b.seatsPerRow != null) sec.seatsPerRow = Math.max(1, Number(b.seatsPerRow))
  }
  if (b.name != null) sec.name = b.name
  if (b.phaseId != null) { if (!phaseById(b.phaseId)) throw httpErr(400, 'Invalid phase'); sec.phaseId = b.phaseId }
  if (b.premium != null) sec.premium = !!b.premium
  if (b.active != null) sec.active = !!b.active
  if (b.prices) {
    for (const [cid, price] of Object.entries(b.prices)) {
      if (!categoryById(cid)) throw httpErr(400, `Unknown category ${cid}`)
      if (price === null || price === '') delete sec.prices[cid]
      else sec.prices[cid] = money(Number(price))
    }
  }
  save()
  ok(ctx.res, { section: sec })
})
route('DELETE', '/api/admin/sections/:id', (ctx) => {
  requireAdmin(ctx.req)
  const sec = sectionById(ctx.params.id)
  if (!sec) throw httpErr(404, 'Section not found')
  const inUse = Object.values(DATA.availability).some((m) => Object.keys(m).some((sid) => sid.startsWith(sec.id + ':')))
  if (inUse) throw httpErr(409, 'Cannot delete a section that has sold or held seats')
  DATA.sections = DATA.sections.filter((s) => s.id !== sec.id)
  save()
  ok(ctx.res, { deleted: sec.id })
})
route('PUT', '/api/admin/categories/:id', async (ctx) => {
  requireAdmin(ctx.req)
  const cat = categoryById(ctx.params.id)
  if (!cat) throw httpErr(404, 'Category not found')
  const b = ctx.body
  if (b.name != null) cat.name = b.name
  if (b.basePrice != null) cat.basePrice = money(Number(b.basePrice))
  if (b.color != null) cat.color = b.color
  if (b.description != null) cat.description = b.description
  if (b.active != null) cat.active = !!b.active
  save()
  ok(ctx.res, { category: cat })
})
route('PUT', '/api/admin/phases/:id', async (ctx) => {
  requireAdmin(ctx.req)
  const phase = phaseById(ctx.params.id)
  if (!phase) throw httpErr(404, 'Phase not found')
  if (ctx.body.name != null) phase.name = ctx.body.name
  if (ctx.body.description != null) phase.description = ctx.body.description
  if (ctx.body.onSale != null) phase.onSale = !!ctx.body.onSale
  save()
  ok(ctx.res, { phase })
})
route('POST', '/api/admin/events', async (ctx) => {
  requireAdmin(ctx.req)
  const b = ctx.body
  if (!b.name || !b.date) throw httpErr(400, 'Name and date are required')
  const ev = {
    id: id('ev'), name: b.name, category: b.category || 'Event',
    description: b.description || '', venue: b.venue || S().venueName,
    date: new Date(b.date).toISOString(), status: b.status || 'DRAFT', featured: !!b.featured,
  }
  DATA.events.push(ev)
  save()
  ok(ctx.res, { event: ev })
})
route('PUT', '/api/admin/events/:id', async (ctx) => {
  requireAdmin(ctx.req)
  const ev = DATA.events.find((e) => e.id === ctx.params.id)
  if (!ev) throw httpErr(404, 'Event not found')
  const b = ctx.body
  if (b.name != null) ev.name = b.name
  if (b.category != null) ev.category = b.category
  if (b.description != null) ev.description = b.description
  if (b.venue != null) ev.venue = b.venue
  if (b.date != null) ev.date = new Date(b.date).toISOString()
  if (b.status != null) ev.status = b.status
  if (b.featured != null) ev.featured = !!b.featured
  save()
  ok(ctx.res, { event: ev })
})
route('DELETE', '/api/admin/events/:id', (ctx) => {
  requireAdmin(ctx.req)
  const ev = DATA.events.find((e) => e.id === ctx.params.id)
  if (!ev) throw httpErr(404, 'Event not found')
  if (DATA.orders.some((o) => o.eventId === ev.id)) throw httpErr(409, 'Cannot delete an event that has orders')
  DATA.events = DATA.events.filter((e) => e.id !== ev.id)
  save()
  ok(ctx.res, { deleted: ev.id })
})
route('POST', '/api/admin/promos', async (ctx) => {
  requireAdmin(ctx.req)
  const b = ctx.body
  const code = String(b.code || '').trim().toUpperCase()
  if (!code) throw httpErr(400, 'Code is required')
  if (DATA.promos.some((p) => p.code === code)) throw httpErr(409, 'Promo code already exists')
  const promo = { code, description: b.description || '', type: b.type === 'FIXED' ? 'FIXED' : 'PERCENT', value: Number(b.value) || 0, minAmount: Number(b.minAmount) || 0, active: b.active !== false, usedCount: 0 }
  DATA.promos.push(promo)
  save()
  ok(ctx.res, { promo })
})
route('PUT', '/api/admin/promos/:code', async (ctx) => {
  requireAdmin(ctx.req)
  const promo = DATA.promos.find((p) => p.code === ctx.params.code.toUpperCase())
  if (!promo) throw httpErr(404, 'Promo not found')
  if (ctx.body.active != null) promo.active = !!ctx.body.active
  if (ctx.body.value != null) promo.value = Number(ctx.body.value)
  save()
  ok(ctx.res, { promo })
})
route('PUT', '/api/admin/settings', async (ctx) => {
  requireAdmin(ctx.req)
  const b = ctx.body
  for (const key of ['venueName', 'siteTagline', 'supportEmail', 'paymentMode']) if (b[key] != null) S()[key] = b[key]
  if (b.holdMinutes != null) S().holdMinutes = Math.max(0.02, Number(b.holdMinutes) || 10)
  if (b.maxSeatsPerOrder != null) S().maxSeatsPerOrder = Math.max(1, Number(b.maxSeatsPerOrder))
  if (b.mpesaEnabled != null) S().mpesaEnabled = !!b.mpesaEnabled
  if (b.cardEnabled != null) S().cardEnabled = !!b.cardEnabled
  save()
  ok(ctx.res, { settings: S() })
})

// js port of autoSectionRect for admin-added sections
const PITCH = { x: 230, y: 160, w: 540, h: 360 }
function autoSectionRectJs(side, levelOrder, index, count) {
  const t = 40, g = 6, r = Math.max(1, levelOrder), n = Math.max(1, count)
  if (side === 'NORTH' || side === 'SOUTH') {
    const w = PITCH.w / n
    return { x: PITCH.x + index * w, y: side === 'NORTH' ? PITCH.y - g - r * t - (r - 1) * g : PITCH.y + PITCH.h + g + (r - 1) * (t + g), w, h: t }
  }
  const h = PITCH.h / n
  return { x: side === 'WEST' ? PITCH.x - g - r * t - (r - 1) * g : PITCH.x + PITCH.w + g + (r - 1) * (t + g), y: PITCH.y + index * h, w: t, h }
}

// ---------------------------------------------------------------- static
function serveStatic(req, res) {
  const url = (req.url || '/').split('?')[0]
  if (url === '/data.json' || url === '/server.js') { err(res, 403, 'Forbidden'); return }
  fs.readFile(INDEX_FILE, (e, buf) => {
    if (e) { res.writeHead(500); res.end('index.html not found next to server.js'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(buf)
  })
}

// ---------------------------------------------------------------- dispatch
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const pathname = decodeURIComponent(u.pathname)
  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (!pathname.startsWith('/api/')) return serveStatic(req, res)
  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = pathname.match(r.rx)
    if (!m) continue
    const params = {}
    r.keys.forEach((k, i) => (params[k] = m[i + 1]))
    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {}
      await r.handler({ req, res, params, body, query: u.searchParams })
    } catch (e) {
      if (e && e.status) err(res, e.status, e.message, e.extra)
      else { console.error(e); err(res, 500, 'Internal server error') }
    }
    return
  }
  err(res, 404, 'Not found')
})

server.listen(PORT, () => {
  console.log('')
  console.log('  TalantaTix Kenya — standalone ticketing server')
  console.log('  ──────────────────────────────────────────────')
  console.log(`  Storefront & API : http://localhost:${PORT}`)
  console.log(`  Data file        : ${DATA_FILE}`)
  console.log('  Admin login      : admin@talantatix.ke / Admin@123')
  console.log('  Staff login      : staff@talantatix.ke / Staff@123')
  console.log('')
})
