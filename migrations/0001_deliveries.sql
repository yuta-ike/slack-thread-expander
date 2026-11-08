CREATE TABLE deliveries (
  message_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'sent')),
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  sent_ts TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX deliveries_updated_at ON deliveries(updated_at);
