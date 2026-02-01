import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import { IncomingMessage } from "http";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

class WebSocketRateLimiter {
  private windowSize: number;
  private maxMessages: number;
  private maxConnections: number;
  private connectionWindow: number;
  private maxConnectionAttempts: number;
  private messageCache: Map<string, any>;
  private connectionCache: Map<string, any>;
  private activeConnections: Map<string, number>;
  private blockedIPs: Map<string, any>;
  private cleanupInterval: NodeJS.Timeout;

  constructor(options: any = {}) {
    this.windowSize = options.windowSize || 60 * 1000;
    this.maxMessages = options.maxMessages || 50;
    this.maxConnections = options.maxConnections || 5;
    this.connectionWindow = options.connectionWindow || 5 * 60 * 1000;
    this.maxConnectionAttempts = options.maxConnectionAttempts || 10;

    this.messageCache = new Map();
    this.connectionCache = new Map();
    this.activeConnections = new Map();
    this.blockedIPs = new Map();

    this.cleanupInterval = setInterval(() => this.cleanup(), 2 * 60 * 1000);
  }

  getClientIP(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    const realIP = req.headers['x-real-ip'];
    const remoteIP = req.socket?.remoteAddress;

    let ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
    ip = ip || (Array.isArray(realIP) ? realIP[0] : realIP) || remoteIP || '127.0.0.1';

    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    return ip;
  }

  isIPBlocked(ip: string): boolean {
    const blockInfo = this.blockedIPs.get(ip);
    if (!blockInfo) return false;

    const now = Date.now();
    if (now - blockInfo.blockedAt > blockInfo.blockDuration) {
      this.blockedIPs.delete(ip);
      return false;
    }
    return true;
  }

  blockIP(ip: string, reason: string, duration = 5 * 60 * 1000): void {
    this.blockedIPs.set(ip, {
      reason,
      blockedAt: Date.now(),
      blockDuration: duration
    });
  }

  checkConnectionAttempts(ip: string) {
    const now = Date.now();

    if (!this.connectionCache.has(ip)) {
      this.connectionCache.set(ip, {
        attempts: 1,
        windowStart: now,
        lastAttempt: now
      });
      return { allowed: true, remaining: this.maxConnectionAttempts - 1 };
    }

    const data = this.connectionCache.get(ip);

    if (now - data.windowStart >= this.connectionWindow) {
      data.attempts = 1;
      data.windowStart = now;
      data.lastAttempt = now;
      return { allowed: true, remaining: this.maxConnectionAttempts - 1 };
    }

    data.attempts++;
    data.lastAttempt = now;

    const remaining = Math.max(0, this.maxConnectionAttempts - data.attempts);
    const allowed = data.attempts <= this.maxConnectionAttempts;

    if (!allowed) {
      this.blockIP(ip, 'Too many connection attempts', 10 * 60 * 1000);
    }

    return { allowed, remaining };
  }

  checkConcurrentConnections(ip: string) {
    const current = this.activeConnections.get(ip) || 0;
    return {
      allowed: current < this.maxConnections,
      current,
      max: this.maxConnections
    };
  }

  addConnection(ip: string, ws: any): void {
    const current = this.activeConnections.get(ip) || 0;
    this.activeConnections.set(ip, current + 1);

    const removeConnection = () => {
      const remaining = (this.activeConnections.get(ip) || 1) - 1;
      if (remaining <= 0) {
        this.activeConnections.delete(ip);
      } else {
        this.activeConnections.set(ip, remaining);
      }
    };

    ws.on('close', removeConnection);
    ws.on('error', removeConnection);
  }

  checkMessageRateLimit(ip: string) {
    const now = Date.now();

    if (!this.messageCache.has(ip)) {
      this.messageCache.set(ip, {
        count: 1,
        windowStart: now,
        lastMessage: now
      });
      return { allowed: true, remaining: this.maxMessages - 1 };
    }

    const data = this.messageCache.get(ip);

    if (now - data.windowStart >= this.windowSize) {
      data.count = 1;
      data.windowStart = now;
      data.lastMessage = now;
      return { allowed: true, remaining: this.maxMessages - 1 };
    }

    data.count++;
    data.lastMessage = now;

    const remaining = Math.max(0, this.maxMessages - data.count);
    const allowed = data.count <= this.maxMessages;

    if (!allowed) {
      this.blockIP(ip, 'Message rate limit exceeded', 2 * 60 * 1000);
    }

    return { allowed, remaining };
  }

  private cleanup(): void {
    const now = Date.now();
    const expireTime = Math.max(this.windowSize, this.connectionWindow) * 2;

    for (const [ip, data] of this.messageCache.entries()) {
      if (now - data.lastMessage > expireTime) {
        this.messageCache.delete(ip);
      }
    }

    for (const [ip, data] of this.connectionCache.entries()) {
      if (now - data.lastAttempt > expireTime) {
        this.connectionCache.delete(ip);
      }
    }

    for (const [ip, blockInfo] of this.blockedIPs.entries()) {
      if (now - blockInfo.blockedAt > blockInfo.blockDuration) {
        this.blockedIPs.delete(ip);
      }
    }
  }
}

const rateLimiter = new WebSocketRateLimiter({
  maxMessages: 50,
  maxConnections: 3,
  maxConnectionAttempts: 15,
  windowSize: 60 * 1000,
  connectionWindow: 5 * 60 * 1000
});

const allowedOrigins = [
  'https://drawdeck.xyz',
  'https://www.drawdeck.xyz',
  // 'http://localhost:3000' 
];

const PORT = Number(process.env.PORT) || 8080;

const wss = new WebSocketServer({
  port: PORT,
  verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
    const ip = rateLimiter.getClientIP(info.req);

    if (rateLimiter.isIPBlocked(ip)) {
      return false;
    }

    const attemptCheck = rateLimiter.checkConnectionAttempts(ip);
    if (!attemptCheck.allowed) {
      return false;
    }

    const concurrentCheck = rateLimiter.checkConcurrentConnections(ip);
    if (!concurrentCheck.allowed) {
      return false;
    }

    if (!allowedOrigins.includes(info.origin)) {
      return false;
    }

    return true;
  }
});

const ROOM_IDLE_TIMEOUT = 10 * 60 * 1000;
const roomLastActivity: Map<string, number> = new Map();

async function updateRoomActivity(roomId: string) {
  roomLastActivity.set(roomId, Date.now());
  await redis.expire(`room:${roomId}:meta`, 3600 * 24);
  await redis.expire(`room:${roomId}:shapes`, 3600 * 24);
}

const HEARTBEAT_INTERVAL = 30000;
const CLIENT_TIMEOUT = 60000;

type ClientInfo = {
  ws: WSWebSocket;
  userId: string;
  rooms: Set<string>;
  lastPing?: number;
  heartbeatTimer?: NodeJS.Timeout;
  ip: string;
};

type Room = {
  participants: Map<string, ClientInfo>;
  secret?: string; // Cached secret
};

const clients = new Set<ClientInfo>();
const rooms: Map<string, Room> = new Map();

function broadcastToRoom(roomId: string, data: any, exclude?: ClientInfo) {
  const room = rooms.get(roomId);
  if (!room) return;

  const message = JSON.stringify(data);

  for (const [userId, client] of room.participants.entries()) {
    if (client !== exclude && client.ws.readyState === client.ws.OPEN) {
      client.ws.send(message);
    }
  }
}

async function handleClientDisconnect(client: ClientInfo) {
  if (client.heartbeatTimer) {
    clearInterval(client.heartbeatTimer);
  }

  for (const roomId of client.rooms) {
    const room = rooms.get(roomId);

    if (room && room.participants.has(client.userId)) {
      room.participants.delete(client.userId);

      // Broadcast user_left
      if (room.participants.size > 0) {
        broadcastToRoom(roomId, {
          type: "user_left",
          roomId,
          userId: client.userId,
          participantCount: room.participants.size,
          timestamp: new Date().toISOString(),
        });
      }

      // If room is empty, just clean up LOCAL memory.
      // Redis data persists (TTL 24h).
      if (room.participants.size === 0) {
        rooms.delete(roomId);
        roomLastActivity.delete(roomId);
      }
    }
  }

  clients.delete(client);
}

wss.on("connection", (ws, request) => {
  const ip = rateLimiter.getClientIP(request);
  const dummyUserId = `user_${Math.floor(Math.random() * 10000)}`;
  const client: ClientInfo = {
    ws,
    userId: dummyUserId,
    rooms: new Set(),
    lastPing: Date.now(),
    ip: ip
  };
  clients.add(client);
  rateLimiter.addConnection(ip, ws);

  ws.on("message", async (raw) => {
    try {
      const messageCheck = rateLimiter.checkMessageRateLimit(client.ip);
      if (!messageCheck.allowed) {
        ws.send(JSON.stringify({
          type: "rate_limit_exceeded",
          message: "Too many messages. Please slow down.",
          retryAfter: 60
        }));
        return;
      }
      const data = JSON.parse(raw.toString());
      const { type, roomId, shape, shapeId } = data;

      switch (type) {
        case "create_room": {
          const newRoom = roomId || `room_${Date.now()}`;
          const encryptionKey = data.encryptionKey;
          const roomType = data.roomType || 'group';

          if (!encryptionKey) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Missing encryption key.",
            }));
            return;
          }

          const exists = await redis.exists(`room:${newRoom}:meta`);
          if (!exists) {
            await redis.hmset(`room:${newRoom}:meta`, {
              secret: encryptionKey,
              creatorId: client.userId,
              type: roomType,
              createdAt: Date.now()
            });
            await redis.expire(`room:${newRoom}:meta`, 3600 * 24);
          }

          if (!rooms.has(newRoom)) {
            rooms.set(newRoom, { participants: new Map(), secret: encryptionKey });
          }

          const room = rooms.get(newRoom)!;
          if (room.secret !== encryptionKey) room.secret = encryptionKey; // Sync local

          room.participants.set(client.userId, client);
          client.rooms.add(newRoom);

          ws.send(JSON.stringify({
            type: "room_created",
            roomId: newRoom,
            userId: client.userId,
          }));
          updateRoomActivity(newRoom);
          break;
        }

        case "join-room": {
          if (!roomId) return;
          const encryptionKey = data.encryptionKey;

          const meta = await redis.hgetall(`room:${roomId}:meta`);
          if (!meta || !meta.secret) {
            ws.send(JSON.stringify({
              type: "error",
              message: `Room "${roomId}" does not exist.`,
            }));
            return;
          }

          const expectedKey = meta.secret;
          if (!expectedKey || encryptionKey !== expectedKey) {
            ws.send(JSON.stringify({
              type: "error",
              message: "Invalid or missing encryption key.",
            }));
            return;
          }

          if (!rooms.has(roomId)) {
            rooms.set(roomId, { participants: new Map(), secret: expectedKey });
          }
          const room = rooms.get(roomId)!;
          if (!room.secret) room.secret = expectedKey;

          const roomType = meta.type || 'group';

          if (room.participants.has(client.userId)) {
            room.participants.set(client.userId, client);
            client.rooms.add(roomId);
            ws.send(JSON.stringify({
              type: "joined_successfully",
              roomId,
              userId: client.userId,
              reconnected: true,
            }));
            const shapes = await redis.hvals(`room:${roomId}:shapes`);
            shapes.forEach(s => {
              ws.send(JSON.stringify({
                type: "shape_add",
                roomId,
                userId: "system",
                shape: JSON.parse(s)
              }));
            });
            break;
          }

          if (roomType === 'duo' && room.participants.size >= 2) {
            let realParams = 0;
            for (const [_, p] of room.participants) {
              if (p.ws.readyState === WSWebSocket.OPEN) realParams++;
            }

            if (realParams >= 2) {
              ws.send(JSON.stringify({
                type: "room_full",
                message: "This duo room is full.",
                roomId: roomId,
                maxCapacity: 2,
                currentCount: realParams,
              }));
              return;
            }
          }

          room.participants.set(client.userId, client);
          client.rooms.add(roomId);

          ws.send(JSON.stringify({
            type: "joined_successfully",
            roomId,
            userId: client.userId,
          }));

          const shapes = await redis.hvals(`room:${roomId}:shapes`);
          shapes.forEach(s => {
            ws.send(JSON.stringify({
              type: "shape_add",
              roomId,
              userId: "system",
              shape: JSON.parse(s)
            }));
          });

          broadcastToRoom(roomId, {
            type: "join-room",
            userId: client.userId,
            roomId,
            participantCount: room.participants.size,
            timestamp: new Date().toISOString(),
          }, client);
          break;
        }

        case "shape_add": {
          if (!roomId || !shape) return;
          const encryptionKey = data.encryptionKey;

          const room = rooms.get(roomId);
          if (room && room.secret) {
            if (encryptionKey !== room.secret) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid key" }));
              return;
            }
          } else {
            const meta = await redis.hgetall(`room:${roomId}:meta`);
            if (!meta.secret || encryptionKey !== meta.secret) return;
            if (room) room.secret = meta.secret;
          }

          await redis.hset(`room:${roomId}:shapes`, shape.id, JSON.stringify(shape));
          await redis.expire(`room:${roomId}:shapes`, 3600 * 24);

          broadcastToRoom(roomId, {
            type: "shape_add",
            roomId,
            userId: client.userId,
            shape,
            timestamp: new Date().toISOString(),
          }, client);
          updateRoomActivity(roomId);
          break;
        }

        case "shape_delete": {
          if (!roomId || !shapeId) return;
          const encryptionKey = data.encryptionKey;

          const room = rooms.get(roomId);
          if (room && room.secret) {
            if (encryptionKey !== room.secret) return;
          } else {
            const meta = await redis.hgetall(`room:${roomId}:meta`);
            if (!meta.secret || encryptionKey !== meta.secret) return;
          }

          await redis.hdel(`room:${roomId}:shapes`, shapeId);

          broadcastToRoom(roomId, {
            type: "shape_delete",
            roomId,
            userId: client.userId,
            shapeId,
            timestamp: new Date().toISOString(),
          }, client);
          updateRoomActivity(roomId);
          break;
        }

        case "shape_update": {
          if (!roomId || !data.shape) return;
          const encryptionKey = data.encryptionKey;

          const room = rooms.get(roomId);
          if (room && room.secret) {
            if (encryptionKey !== room.secret) return;
          } else {
            const meta = await redis.hgetall(`room:${roomId}:meta`);
            if (!meta.secret || encryptionKey !== meta.secret) return;
          }

          await redis.hset(`room:${roomId}:shapes`, data.shape.id, JSON.stringify(data.shape));
          await redis.expire(`room:${roomId}:shapes`, 3600 * 24);

          broadcastToRoom(roomId, {
            type: "shape_update",
            roomId,
            userId: client.userId,
            shape: data.shape,
            timestamp: new Date().toISOString(),
          }, client);
          updateRoomActivity(roomId);
          break;
        }

        case "cursor_move": {
          if (!roomId) return;
          const encryptionKey = data.encryptionKey;

          const room = rooms.get(roomId);
          if (!room) return;
          if (room.secret) {
            if (encryptionKey !== room.secret) return;
          }

          broadcastToRoom(roomId, {
            type: "cursor_move",
            roomId,
            userId: client.userId,
            x: data.x,
            y: data.y,
            userName: data.userName,
            color: data.color
          }, client);
          break;
        }

        case "leave_room": {
          if (!roomId) return;
          handleClientDisconnect(client);
          ws.close(1000, 'User left room');
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error(err);
    }
  });

  client.heartbeatTimer = setInterval(() => {
    if (ws.readyState === WSWebSocket.OPEN) {
      const now = Date.now();
      if (client.lastPing && (now - client.lastPing) > CLIENT_TIMEOUT) {
        ws.terminate();
        handleClientDisconnect(client);
        return;
      }

      try {
        ws.ping();
      } catch (error) {
        handleClientDisconnect(client);
      }
    } else {
      handleClientDisconnect(client);
    }
  }, HEARTBEAT_INTERVAL);

  ws.on('pong', () => {
    client.lastPing = Date.now();
  });

  ws.on("close", () => {
    handleClientDisconnect(client);
  });

  ws.on("error", (error) => {
    handleClientDisconnect(client);
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [roomId, lastActivity] of roomLastActivity.entries()) {
    if (now - lastActivity > ROOM_IDLE_TIMEOUT) {
      const room = rooms.get(roomId);
      if (room) {
        const idleMinutes = Math.floor((now - lastActivity) / 1000 / 60);
        const messageData = {
          type: "session_ended_inactivity",
          message: `Room was closed due to ${idleMinutes} minutes of no drawing activity.`,
          roomId: roomId,
          idleTime: idleMinutes,
          reason: "no_drawing_activity"
        };

        const participants = Array.from(room.participants.values());
        participants.forEach(client => {
          if (client.ws.readyState === WSWebSocket.OPEN) client.ws.send(JSON.stringify(messageData));
        });

        setTimeout(() => {
          participants.forEach(client => {
            if (client.ws.readyState === WSWebSocket.OPEN) client.ws.close(4000, 'Inactivity');
          });
          // Just clean up local state
          rooms.delete(roomId);
          roomLastActivity.delete(roomId);
        }, 3000);
      }
    }
  }
}, 10 * 1000);

console.log(`WebSocket server running on port ${PORT}`);