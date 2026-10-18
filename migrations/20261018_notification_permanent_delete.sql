-- Bell inbox: "Delete permanently" (store-wide) for notification alerts.
-- Additive and safe to rerun. Deleted alerts stay as tombstones so the
-- startup history backfill (ON CONFLICT source_key) can never recreate them.
-- Orders, sales, stock and expenses are never touched by this feature.
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(120);
CREATE INDEX IF NOT EXISTS idx_notification_events_live
    ON notification_events (created_at DESC, id DESC) WHERE deleted_at IS NULL;
