package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type terminalControlMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	sessionID := extractPathParam(r.URL.Path, "/api/v1/terminal/")
	if sessionID == "" {
		http.Error(w, "missing session id", http.StatusBadRequest)
		return
	}

	if s.sessionMgr == nil {
		http.Error(w, "terminal unavailable", http.StatusServiceUnavailable)
		return
	}

	session := s.sessionMgr.Get(sessionID)
	if session == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("terminal ws upgrade: %v", err)
		return
	}
	defer conn.Close()

	var (
		writeMu    sync.Mutex
		closeOnce  sync.Once
		bridgeOnce sync.Once
		done       = make(chan struct{})
	)

	closeBridge := func() {
		bridgeOnce.Do(func() {
			close(done)
		})
	}
	writeWS := func(msgType int, data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteMessage(msgType, data)
	}
	sendClose := func() {
		closeOnce.Do(func() {
			_ = writeWS(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		})
	}

	conn.SetReadLimit(8192)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := writeWS(websocket.PingMessage, nil); err != nil {
					closeBridge()
					return
				}
			}
		}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := session.Pty.Read(buf)
			if n > 0 {
				if werr := writeWS(websocket.BinaryMessage, buf[:n]); werr != nil {
					closeBridge()
					return
				}
			}
			if err != nil {
				sendClose()
				closeBridge()
				return
			}
			select {
			case <-done:
				return
			default:
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		default:
		}

		msgType, data, err := conn.ReadMessage()
		if err != nil {
			closeBridge()
			return
		}

		switch msgType {
		case websocket.BinaryMessage:
			if _, err := s.sessionMgr.Write(sessionID, data); err != nil {
				if !errors.Is(err, io.EOF) {
					log.Printf("terminal ws write pty %s: %v", sessionID, err)
				}
				closeBridge()
				return
			}
		case websocket.TextMessage:
			var ctrl terminalControlMessage
			if err := json.Unmarshal(data, &ctrl); err != nil {
				continue
			}
			if ctrl.Type == "resize" {
				if err := s.sessionMgr.Resize(sessionID, ctrl.Cols, ctrl.Rows); err != nil {
					log.Printf("terminal ws resize %s: %v", sessionID, err)
				}
			}
		}
	}
}
