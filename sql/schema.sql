CREATE SCHEMA IF NOT EXISTS postador;

CREATE TABLE IF NOT EXISTS postador.niches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  clip_keywords TEXT[],
  voice_id TEXT NOT NULL,
  mascot_image_url TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'manual',
  youtube_made_for_kids BOOLEAN NOT NULL DEFAULT true,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.topics_used (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  topic TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.video_runs (
  id SERIAL PRIMARY KEY,
  niche_id INTEGER NOT NULL REFERENCES postador.niches(id),
  status TEXT NOT NULL DEFAULT 'em_progresso',
  current_step TEXT,
  topic TEXT,
  script_text TEXT,
  voice_url TEXT,
  captions_json JSONB,
  assets_json JSONB,
  music_url TEXT,
  render_16x9_url TEXT,
  render_9x16_url TEXT,
  thumbnail_url TEXT,
  youtube_video_id TEXT,
  youtube_shorts_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postador.costs (
  id SERIAL PRIMARY KEY,
  video_run_id INTEGER NOT NULL REFERENCES postador.video_runs(id),
  step TEXT NOT NULL,
  provider TEXT NOT NULL,
  estimated_cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
