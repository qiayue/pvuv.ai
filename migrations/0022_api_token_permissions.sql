ALTER TABLE api_tokens ADD COLUMN permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'ingest'));
