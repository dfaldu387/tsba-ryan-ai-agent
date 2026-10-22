-- One-time Postgres provisioning for the TSBA admin panel.
-- Run as a superuser (e.g. the 'postgres' role):
--   psql -U postgres -h localhost -f db/setup-postgres.sql
-- Creates the app role and database that DATABASE_URL in .env points at.
-- No pgvector required (embeddings are stored as real[]).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tsba') THEN
    CREATE ROLE tsba LOGIN PASSWORD 'tsba';
  ELSE
    ALTER ROLE tsba LOGIN PASSWORD 'tsba';
  END IF;
END
$$;

SELECT 'CREATE DATABASE tsba OWNER tsba'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tsba')\gexec

GRANT ALL PRIVILEGES ON DATABASE tsba TO tsba;
