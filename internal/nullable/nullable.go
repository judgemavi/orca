// Package nullable provides helpers for nil pointers and SQL nullable values.
package nullable

// Deref returns the pointed value or zero value when ptr is nil.
func Deref[T any](ptr *T) T {
	if ptr == nil {
		var zero T
		return zero
	}
	return *ptr
}
