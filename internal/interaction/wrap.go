package interaction

import "fmt"

// Wrap executes fn within a tracked interaction.
// It marks the interaction failed when fn returns an error, otherwise completed.
func Wrap(store *Store, taskRef *string, phase, tool string, fn func(writer *Writer) error) error {
	if store == nil {
		return fmt.Errorf("interaction store required")
	}

	writer, err := store.Begin(taskRef, phase, tool)
	if err != nil {
		return fmt.Errorf("begin %s interaction: %w", phase, err)
	}
	defer writer.Close()

	if err := fn(writer); err != nil {
		_ = store.Finish(writer.ID(), "failed", WithError(err.Error()))
		return err
	}

	if err := store.Finish(writer.ID(), "completed"); err != nil {
		return fmt.Errorf("finish %s interaction: %w", phase, err)
	}
	return nil
}

// WrapWithOpts executes fn within a tracked interaction and attaches finish options on success.
func WrapWithOpts(store *Store, taskRef *string, phase, tool string, fn func(writer *Writer) ([]FinishOption, error)) error {
	if store == nil {
		return fmt.Errorf("interaction store required")
	}

	writer, err := store.Begin(taskRef, phase, tool)
	if err != nil {
		return fmt.Errorf("begin %s interaction: %w", phase, err)
	}
	defer writer.Close()

	opts, err := fn(writer)
	if err != nil {
		_ = store.Finish(writer.ID(), "failed", WithError(err.Error()))
		return err
	}

	if err := store.Finish(writer.ID(), "completed", opts...); err != nil {
		return fmt.Errorf("finish %s interaction: %w", phase, err)
	}
	return nil
}
