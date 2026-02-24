package config

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

const configKey = "config"

// LoadFromDB reads config from the config table. If no config row exists, defaults are returned.
func LoadFromDB(db *sql.DB) (*Config, error) {
	cfg, err := Default()
	if err != nil {
		return nil, fmt.Errorf("default config: %w", err)
	}

	var data string
	err = db.QueryRow(`SELECT value FROM config WHERE key = ?`, configKey).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return &cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query config: %w", err)
	}

	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return &cfg, nil
}

// SaveToDB stores config as a single JSON value in the config table.
func (c *Config) SaveToDB(db *sql.DB) error {
	if err := c.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	data, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	if _, err := db.Exec(
		`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`,
		configKey,
		string(data),
	); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	return nil
}

// UpdateFromDB applies a partial JSON patch over the persisted config, validates,
// and stores the merged result.
func UpdateFromDB(db *sql.DB, patch json.RawMessage) (*Config, error) {
	cfg, err := LoadFromDB(db)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(patch, cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config patch: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	if err := cfg.SaveToDB(db); err != nil {
		return nil, err
	}
	return cfg, nil
}
