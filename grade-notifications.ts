import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'

/* configuration values */
import {
	MAX_CONNECTIONS_PER_STUDENT,
	NOTIFICATION_TTL_MS,
	CLEANUP_INTERVAL_MS,
} from './constants/constants'

/* type definitions */
import {
	StudentId,
	Notification,
	PublishBody,
	BatchPublishBody,
} from './types/types'

/* in-memory stores (for demo; would be replaced with Redis/DB in prod) */
const connections: Map<StudentId, Set<FastifyReply>> = new Map()
const recentNotifications: Map<StudentId, Notification[]> = new Map()

/* metrics tracking */
const metrics = {
	connectionsTotal: 0,
	connectionsActive: 0,
	notificationsSent: 0,
	notificationsStored: 0,
	notificationsEvicted: 0,
}

const pruneOldNotifications = (now = Date.now()) => {
	for (const [studentId, list] of recentNotifications.entries()) {
		const filtered = list.filter(
			(n) => now - n.createdAt <= NOTIFICATION_TTL_MS
		)
		const evicted = list.length - filtered.length
		if (evicted > 0) metrics.notificationsEvicted += evicted
		if (filtered.length === 0) {
			recentNotifications.delete(studentId)
		} else {
			recentNotifications.set(studentId, filtered)
		}
	}
}

const addRecentNotification = (n: Notification) => {
	const list = recentNotifications.get(n.studentId) ?? []
	list.push(n)
	recentNotifications.set(n.studentId, list)
	metrics.notificationsStored += 1
	pruneOldNotifications()
}

const broadcastToStudent = (studentId: StudentId, payload: object) => {
	const set = connections.get(studentId)
	if (!set || set.size === 0) return 0
	const data = `data: ${JSON.stringify(payload)}\n\n`
	let sent = 0
	for (const reply of set) {
		try {
			reply.raw.write(data)
			sent++
		} catch {
			// Ignore write errors; cleanup happens on close
		}
	}
	metrics.notificationsSent += sent
	return sent
}

const registerConnection = (studentId: StudentId, reply: FastifyReply) => {
	const set = connections.get(studentId) ?? new Set<FastifyReply>()
	if (set.size >= MAX_CONNECTIONS_PER_STUDENT) {
		// Drop the oldest connection to enforce limit
		const oldest = set.values().next().value as FastifyReply | undefined
		if (oldest) {
			try {
				oldest.raw.end()
			} catch {}
			set.delete(oldest)
			metrics.connectionsActive = Math.max(0, metrics.connectionsActive - 1)
		}
	}
	set.add(reply)
	connections.set(studentId, set)
	metrics.connectionsTotal += 1
	metrics.connectionsActive += 1
}

const unregisterConnection = (studentId: StudentId, reply: FastifyReply) => {
	const set = connections.get(studentId)
	if (!set) return
	if (set.delete(reply)) {
		metrics.connectionsActive = Math.max(0, metrics.connectionsActive - 1)
	}
	if (set.size === 0) connections.delete(studentId)
}

const sseHeaders = (reply: FastifyReply) => {
	reply.raw.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})
}

const keepAlive = (reply: FastifyReply) => {
	const interval = setInterval(() => {
		try {
			reply.raw.write(': ping\n\n')
		} catch {}
	}, 15000)
	reply.raw.on('close', () => clearInterval(interval))
}

export const createServer = (): FastifyInstance => {
	const app = Fastify({ logger: false })

	/* health/metrics */
	app.get('/health', async () => ({ status: 'ok' }))
	app.get('/metrics', async () => ({
		...metrics,
		studentsWithConnections: connections.size,
	}))

	/* demo page for presentation purposes */
	app.get('/', async (_req, reply) => reply.redirect('/demo'))
	app.get('/demo', async (_req, reply) => {
		const file = path.join(__dirname, 'public', 'demo.html')
		try {
			const html = fs.readFileSync(file, 'utf8')
			reply.type('text/html').send(html)
		} catch (e) {
			reply.code(404).send('Demo page not found')
		}
	})

	/* SSE subscription for student */
	app.get('/sse', async (request: FastifyRequest, reply: FastifyReply) => {
		const studentId = (request.query as any).studentId as string
		if (!studentId) {
			reply.code(400).send({ error: 'studentId is required' })
			return
		}

		sseHeaders(reply)
		keepAlive(reply)

		/* register connection */
		registerConnection(studentId, reply)

		/* send an initial comment to open the stream */
		reply.raw.write(`: connected ${Date.now()}\n\n`)

		/* send missed notifications (last 24h) */
		pruneOldNotifications()
		const missed = recentNotifications.get(studentId) ?? []
		if (missed.length > 0) {
			for (const n of missed) {
				const evt = {
					type: 'missed',
					id: n.id,
					message: n.message,
					createdAt: n.createdAt,
				}
				try {
					reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`)
				} catch {}
			}
		}

		/* cleanup on close */
		const onClose = () => unregisterConnection(studentId, reply)
		reply.raw.on('close', onClose)
		reply.raw.on('end', onClose)

		/* keep the connection open */
		return
	})

	/* publish a single notification */
	app.post(
		'/publish',
		async (request: FastifyRequest<{ Body: PublishBody }>, reply) => {
			const { studentId, message } = request.body || ({} as PublishBody)
			if (!studentId || !message)
				return reply.code(400).send({ error: 'studentId and message required' })
			const n: Notification = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				studentId,
				message,
				createdAt: Date.now(),
			}
			addRecentNotification(n)
			broadcastToStudent(studentId, {
				type: 'live',
				id: n.id,
				message: n.message,
				createdAt: n.createdAt,
			})
			reply.code(202).send({ ok: true, id: n.id })
		}
	)

	/* batch publish notifications */
	app.post(
		'/publish/batch',
		async (request: FastifyRequest<{ Body: BatchPublishBody }>, reply) => {
			const body = request.body as BatchPublishBody | undefined
			if (
				!body ||
				!Array.isArray(body.notifications) ||
				body.notifications.length === 0
			) {
				return reply.code(400).send({ error: 'notifications array required' })
			}
			const results = [] as { id: string; studentId: string }[]
			for (const p of body.notifications) {
				if (!p.studentId || !p.message) continue
				const n: Notification = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
					studentId: p.studentId,
					message: p.message,
					createdAt: Date.now(),
				}
				addRecentNotification(n)
				broadcastToStudent(p.studentId, {
					type: 'live',
					id: n.id,
					message: n.message,
					createdAt: n.createdAt,
				})
				results.push({ id: n.id, studentId: p.studentId })
			}
			reply.code(202).send({ ok: true, count: results.length, ids: results })
		}
	)

	/* background cleanup task */
	const interval = setInterval(
		() => pruneOldNotifications(),
		CLEANUP_INTERVAL_MS
	)
	app.addHook('onClose', async () => clearInterval(interval))

	return app
}

/* if executed directly, start the server */
if (require.main === module) {
	const app = createServer()
	const port = Number(process.env.PORT || 3000)
	app
		.listen({ port, host: '0.0.0.0' })
		.then(() => {
			// eslint-disable-next-line no-console
			console.log(`Server listening on http://localhost:${port}`)
		})
		.catch((err) => {
			// eslint-disable-next-line no-console
			console.error(err)
			process.exit(1)
		})
}
