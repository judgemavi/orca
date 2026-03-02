package task

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func (s *Store) AddReview(taskID, feedback, interactionID string) (string, error) {
	id := uuid.New().String()
	var interactionIDValue interface{}
	if interactionID != "" {
		interactionIDValue = interactionID
	}
	_, err := s.db.Exec(
		`INSERT INTO task_reviews (id, task_id, interaction_id, feedback, status) VALUES (?, ?, ?, ?, 'pending')`,
		id, taskID, interactionIDValue, feedback,
	)
	if err != nil {
		return "", fmt.Errorf("add task review: %w", err)
	}
	return id, nil
}

func (s *Store) GetPendingReview(taskID string) (id, feedback string, err error) {
	err = s.db.QueryRow(
		`SELECT id, feedback
		 FROM task_reviews
		 WHERE task_id = ? AND status = 'pending'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		taskID,
	).Scan(&id, &feedback)
	if err != nil {
		return "", "", err
	}
	return id, feedback, nil
}

func (s *Store) AddressReview(reviewID string) error {
	_, err := s.db.Exec(
		`UPDATE task_reviews
		 SET status = 'addressed', addressed_at = ?
		 WHERE id = ?`,
		time.Now().UTC(), reviewID,
	)
	if err != nil {
		return fmt.Errorf("address task review: %w", err)
	}
	return nil
}

func (s *Store) ListReviews(taskID string) ([]TaskReview, error) {
	rows, err := s.db.Query(
		`SELECT id, task_id, interaction_id, feedback, status, created_at, addressed_at
		 FROM task_reviews
		 WHERE task_id = ?
		 ORDER BY created_at`,
		taskID,
	)
	if err != nil {
		return nil, fmt.Errorf("list task reviews: %w", err)
	}
	defer rows.Close()

	var reviews []TaskReview
	for rows.Next() {
		var review TaskReview
		var interactionID sql.NullString
		var addressedAt sql.NullTime
		if err := rows.Scan(
			&review.ID,
			&review.TaskID,
			&interactionID,
			&review.Feedback,
			&review.Status,
			&review.CreatedAt,
			&addressedAt,
		); err != nil {
			return nil, fmt.Errorf("scan task review: %w", err)
		}
		if addressedAt.Valid {
			review.AddressedAt = &addressedAt.Time
		}
		if interactionID.Valid {
			review.InteractionID = &interactionID.String
		}
		reviews = append(reviews, review)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task reviews: %w", err)
	}
	return reviews, nil
}
