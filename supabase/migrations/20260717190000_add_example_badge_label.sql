ALTER TABLE public.examples
  ADD COLUMN badge_label TEXT NOT NULL DEFAULT ''
  CHECK (char_length(badge_label) <= 40);
