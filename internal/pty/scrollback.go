package pty

import "sync"

// Scrollback stores recent PTY output and fans out live bytes to subscribers.
type Scrollback struct {
	mu     sync.RWMutex
	buf    []byte
	size   int
	cap    int
	off    int
	subs   []chan []byte
	closed bool
}

// NewScrollback creates a bounded in-memory ring buffer.
func NewScrollback(capacity int) *Scrollback {
	if capacity <= 0 {
		capacity = 1
	}
	return &Scrollback{
		buf: make([]byte, capacity),
		cap: capacity,
	}
}

// Write appends bytes into the ring and broadcasts to subscribers.
func (s *Scrollback) Write(p []byte) (int, error) {
	n := len(p)
	if n == 0 {
		return 0, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return n, nil
	}

	for _, b := range p {
		s.buf[s.off] = b
		s.off = (s.off + 1) % s.cap
		if s.size < s.cap {
			s.size++
		}
	}

	if len(s.subs) == 0 {
		return n, nil
	}

	kept := s.subs[:0]
	for _, ch := range s.subs {
		msg := append([]byte(nil), p...)
		select {
		case ch <- msg:
			kept = append(kept, ch)
		default:
			close(ch)
		}
	}
	s.subs = kept

	return n, nil
}

// Snapshot returns current scrollback bytes in logical order.
func (s *Scrollback) Snapshot() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.size == 0 {
		return nil
	}

	out := make([]byte, s.size)
	start := s.off - s.size
	if start < 0 {
		start += s.cap
	}

	if start+s.size <= s.cap {
		copy(out, s.buf[start:start+s.size])
		return out
	}

	n := copy(out, s.buf[start:])
	copy(out[n:], s.buf[:s.size-n])
	return out
}

// Subscribe returns a buffered live stream plus an unsubscribe callback.
func (s *Scrollback) Subscribe() (ch chan []byte, unsub func()) {
	ch = make(chan []byte, 64)

	s.mu.Lock()
	if s.closed {
		close(ch)
		s.mu.Unlock()
		return ch, func() {}
	}
	s.subs = append(s.subs, ch)
	s.mu.Unlock()

	var once sync.Once
	unsub = func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			for i, sub := range s.subs {
				if sub == ch {
					s.subs = append(s.subs[:i], s.subs[i+1:]...)
					close(ch)
					return
				}
			}
		})
	}

	return ch, unsub
}

// Close closes all subscriber channels and prevents future subscriptions.
func (s *Scrollback) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	subs := s.subs
	s.subs = nil
	s.mu.Unlock()

	for _, ch := range subs {
		close(ch)
	}
}
