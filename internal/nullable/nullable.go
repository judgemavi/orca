// Package nullable provides helpers for nil pointers and SQL nullable values.
package nullable

import "database/sql"

// Deref returns the pointed value or zero value when ptr is nil.
func Deref[T any](ptr *T) T {
	if ptr == nil {
		var zero T
		return zero
	}
	return *ptr
}

// ToString returns the string value for a valid nullable string, else empty string.
func ToString(v sql.NullString) string {
	if !v.Valid {
		return ""
	}
	return v.String
}

// IfEmpty returns nil when v is empty, otherwise v.
func IfEmpty(v string) interface{} {
	if v == "" {
		return nil
	}
	return v
}
