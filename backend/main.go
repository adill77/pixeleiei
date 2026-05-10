package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	WORLD_SIZE    = 2000
	WRITE_WAIT    = 10 * time.Second
	PONG_WAIT     = 60 * time.Second
	PING_PERIOD   = (PONG_WAIT * 9) / 10
	MAX_MSG_SIZE  = 4096
	COOLDOWN_SEC  = 1
	PUB_SUB_CHAN  = "pixel_draws"
	CANVAS_KEY    = "canvas_binary"
	LEADERBOARD_K = "leaderboard_zset"
	PROFILES_KEY  = "user_profiles"
)

// Palette mapping for binary protocol
var palette = []string{
	"#FFFFFF", "#000000", "#FF3B30", "#FF9500",
	// Row 2: Warm
	"#FFCC00", "#FF6B6B", "#FF8E53", "#FFB347",
	// Row 3: Pastel 🎨
	"#FFB3BA", "#FFDFBA", "#FFFFBA", "#BAFFC9",
	"#BAE1FF", "#E8BAFF", "#FFB3F0", "#C9FFE5",
	// Row 4: Cool
	"#4CD964", "#5AC8FA", "#007AFF", "#5856D6",
	"#FF2D55", "#8E8E93", "#8B572A", "#34C759",
}

var ctx = context.Background()
var rdb *redis.Client
var lastDraw sync.Map

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type WSMessage struct {
	Type        string        `json:"type"`
	UserID      string        `json:"userId,omitempty"`
	ClientID    string        `json:"clientId,omitempty"`
	X           int           `json:"x,omitempty"`
	Y           int           `json:"y,omitempty"`
	Color       string        `json:"color,omitempty"`
	Name        string        `json:"name,omitempty"`
	Data        []Pixel       `json:"data,omitempty"`
	Leaderboard []PlayerScore `json:"leaderboard,omitempty"`
}

type Pixel struct {
	X     int    `json:"x"`
	Y     int    `json:"y"`
	Color string `json:"color"`
}

type PlayerScore struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Score  int    `json:"score"`
	Color  string `json:"color"`
}

type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan []byte
	userID string
}

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.Mutex
}

func newHub() *Hub {
	return &Hub{
		broadcast:  make(chan []byte),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]bool),
	}
}

func (h *Hub) run() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
		case message := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.Unlock()
		case <-ticker.C:
			// Broadcast Leaderboard
			go func() {
				dbCtx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
				defer cancel()

				zlb, _ := rdb.ZRevRangeWithScores(dbCtx, LEADERBOARD_K, 0, 49).Result()
				if len(zlb) == 0 {
					return
				}

				profiles, _ := rdb.HGetAll(dbCtx, PROFILES_KEY).Result()
				var lb []PlayerScore
				for _, z := range zlb {
					uid := z.Member.(string)
					var p struct {
						Name  string `json:"name"`
						Color string `json:"color"`
					}
					json.Unmarshal([]byte(profiles[uid]), &p)
					lb = append(lb, PlayerScore{UserID: uid, Name: p.Name, Score: int(z.Score), Color: p.Color})
				}

				lbMsg, _ := json.Marshal(WSMessage{Type: "leaderboard", Leaderboard: lb})
				h.broadcast <- lbMsg
			}()
		}
	}
}

func (h *Hub) subscribeToRedis() {
	pubsub := rdb.Subscribe(ctx, PUB_SUB_CHAN)
	ch := pubsub.Channel()
	for msg := range ch {
		h.broadcast <- []byte(msg.Payload)
	}
}

// Helper to find palette index
func getPaletteIndex(hex string) uint8 {
	for i, c := range palette {
		if c == hex {
			return uint8(i)
		}
	}
	return 255
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(MAX_MSG_SIZE)
	c.conn.SetReadDeadline(time.Now().Add(PONG_WAIT))
	c.conn.SetPongHandler(func(string) error { c.conn.SetReadDeadline(time.Now().Add(PONG_WAIT)); return nil })

	for {
		messageType, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		// Handle Binary Messages (Draw)
		if messageType == websocket.BinaryMessage && len(message) >= 6 {
			// Cooldown check
			if c.userID != "" {
				now := time.Now()
				if val, ok := lastDraw.Load(c.userID); ok {
					if now.Sub(val.(time.Time)) < time.Second*COOLDOWN_SEC {
						continue
					}
				}
				lastDraw.Store(c.userID, now)
			}

			// Format: [Type(1), X(2), Y(2), ColorIndex(1)]
			x := binary.BigEndian.Uint16(message[1:3])
			y := binary.BigEndian.Uint16(message[3:5])
			colorIdx := message[5]

			if x >= WORLD_SIZE || y >= WORLD_SIZE || int(colorIdx) >= len(palette) {
				continue
			}

			// Update Redis Canvas and Leaderboard
			dbCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			offset := int64(y)*WORLD_SIZE + int64(x)

			pipe := rdb.Pipeline()
			pipe.SetRange(dbCtx, CANVAS_KEY, offset, string([]byte{colorIdx}))
			if c.userID != "" {
				pipe.ZIncrBy(dbCtx, LEADERBOARD_K, 1, c.userID)
			}

			// Broadcast binary draw to all nodes
			pipe.Publish(dbCtx, PUB_SUB_CHAN, message)
			pipe.Exec(dbCtx)
			cancel()
			continue
		}

		// Handle JSON Messages (Profile Update / Leaderboard Request)
		var msg WSMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		if msg.Type == "profile" {
			c.userID = msg.UserID
			dbCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			profileData, _ := json.Marshal(map[string]string{"name": msg.Name, "color": msg.Color})
			rdb.HSet(dbCtx, PROFILES_KEY, msg.UserID, profileData)
			cancel()
		} else if msg.Type == "draw" {
			// Legacy support or fallback
			colorIdx := getPaletteIndex(msg.Color)
			if colorIdx == 255 {
				continue
			}

			dbCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			offset := int64(msg.Y)*WORLD_SIZE + int64(msg.X)

			pipe := rdb.Pipeline()
			pipe.SetRange(dbCtx, CANVAS_KEY, offset, string([]byte{colorIdx}))
			pipe.ZIncrBy(dbCtx, LEADERBOARD_K, 1, msg.UserID)

			// Binary Broadcast
			binDraw := make([]byte, 6)
			binDraw[0] = 1
			binary.BigEndian.PutUint16(binDraw[1:3], uint16(msg.X))
			binary.BigEndian.PutUint16(binDraw[3:5], uint16(msg.Y))
			binDraw[5] = colorIdx
			pipe.Publish(dbCtx, PUB_SUB_CHAN, binDraw)
			pipe.Exec(dbCtx)
			cancel()
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(PING_PERIOD)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(WRITE_WAIT))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			// Check if message is binary draw (Type 1) or initial canvas (Type 0)
			mType := websocket.TextMessage
			if len(message) > 0 && (message[0] == 0 || message[0] == 1) {
				mType = websocket.BinaryMessage
			}
			if err := c.conn.WriteMessage(mType, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(WRITE_WAIT))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func main() {
	redisAddr := os.Getenv("REDIS_URL")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	rdb = redis.NewClient(&redis.Options{Addr: redisAddr})
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("❌ Redis connection failed: %v", err)
	}

	hub := newHub()
	go hub.run()
	go hub.subscribeToRedis()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		client := &Client{hub: hub, conn: conn, send: make(chan []byte, 512)}
		client.hub.register <- client
		go client.writePump()
		go client.readPump()

		// Send Initial State (Optimization: Binary Blob)
		go func() {
			dbCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			// 1. Get entire canvas (4MB)
			canvasBlob, _ := rdb.Get(dbCtx, CANVAS_KEY).Bytes()

			fullCanvas := make([]byte, WORLD_SIZE*WORLD_SIZE)

			copy(fullCanvas, canvasBlob)

			// Packet Type 0: Canvas Blob
			initHeader := []byte{0}
			client.send <- append(initHeader, fullCanvas...)

			// 2. Get Leaderboard (Top 50)
			zlb, _ := rdb.ZRevRangeWithScores(dbCtx, LEADERBOARD_K, 0, 49).Result()
			profiles, _ := rdb.HGetAll(dbCtx, PROFILES_KEY).Result()

			var lb []PlayerScore
			for _, z := range zlb {
				uid := z.Member.(string)
				var p struct {
					Name  string `json:"name"`
					Color string `json:"color"`
				}
				json.Unmarshal([]byte(profiles[uid]), &p)
				lb = append(lb, PlayerScore{UserID: uid, Name: p.Name, Score: int(z.Score), Color: p.Color})
			}

			lbMsg, _ := json.Marshal(WSMessage{Type: "leaderboard", Leaderboard: lb})
			client.send <- lbMsg
		}()
	})

	fmt.Println("🚀 Phase 3 Binary Server on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
