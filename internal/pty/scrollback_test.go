package pty

import (
	"bytes"
	"testing"
	"time"
)

func TestScrollbackSnapshotWrap(t *testing.T) {
	sb := NewScrollback(8)

	if _, err := sb.Write([]byte("abcd")); err != nil {
		t.Fatalf("write initial: %v", err)
	}
	if got := sb.Snapshot(); !bytes.Equal(got, []byte("abcd")) {
		t.Fatalf("snapshot after first write = %q, want %q", got, []byte("abcd"))
	}

	if _, err := sb.Write([]byte("efgh")); err != nil {
		t.Fatalf("write second: %v", err)
	}
	if got := sb.Snapshot(); !bytes.Equal(got, []byte("abcdefgh")) {
		t.Fatalf("snapshot at capacity = %q, want %q", got, []byte("abcdefgh"))
	}

	if _, err := sb.Write([]byte("XYZ")); err != nil {
		t.Fatalf("write overwrite: %v", err)
	}
	if got := sb.Snapshot(); !bytes.Equal(got, []byte("defghXYZ")) {
		t.Fatalf("snapshot after overwrite = %q, want %q", got, []byte("defghXYZ"))
	}
}

func TestScrollbackSubscribeAndUnsubscribe(t *testing.T) {
	sb := NewScrollback(32)
	ch, unsub := sb.Subscribe()

	if _, err := sb.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case got, ok := <-ch:
		if !ok {
			t.Fatal("subscriber closed unexpectedly")
		}
		if !bytes.Equal(got, []byte("hello")) {
			t.Fatalf("subscriber got %q, want %q", got, []byte("hello"))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for subscriber message")
	}

	unsub()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("subscriber channel should be closed after unsubscribe")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for unsubscribe close")
	}
}

func TestScrollbackDropsSlowSubscriber(t *testing.T) {
	sb := NewScrollback(128)
	ch, _ := sb.Subscribe()

	for i := 0; i < 128; i++ {
		if _, err := sb.Write([]byte{byte(i)}); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	timeout := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("slow subscriber was not dropped")
		}
	}
}

func TestScrollbackCloseClosesSubscribers(t *testing.T) {
	sb := NewScrollback(32)
	ch, _ := sb.Subscribe()
	sb.Close()

	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("subscriber channel should be closed after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for close")
	}
}
