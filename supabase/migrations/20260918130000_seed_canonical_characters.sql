-- Migration: seed_canonical_characters
-- Seeds public.characters with the ten original Cartoona characters.
--
-- Why this is required, not cosmetic:
--   The public creation forms offer characters from config/characters.ts (a
--   static list, so the anonymous pages need no database round trip) and store
--   the chosen character's NAME in the session draft. The trusted request RPC
--   resolves p_character_id against public.characters and rejects anything that
--   is not an active row. That table was empty, so every image and video
--   request would have been refused the moment submission was switched on —
--   invisible until now only because the submit button was disabled.
--
--   Seeding here makes the database agree with the list the forms already show.
--   No new product content is invented: these are exactly the characters in
--   config/characters.ts, which AGENTS.md names as the source of truth for the
--   original Cartoona cast. Emoji is deliberately not stored — the column does
--   not exist and the UI already takes it from the config.
--
-- Idempotent: matched by name, so re-running changes nothing and an admin's
-- later edits to a row's description or category are not overwritten.
-- Non-destructive: no row is deleted or deactivated, including any character an
-- admin added by hand.
-- =============================================================================

INSERT INTO public.characters (name, description, category, is_active)
SELECT v.name, v.description, v.category, TRUE
FROM (VALUES
  ('Captain Candy', 'A brave space explorer who sails through candy-filled galaxies.', 'Adventure'),
  ('Princess Luma', 'A gentle princess who brings light and kindness to everyone she meets.', 'Fantasy'),
  ('Dino Dodo', 'A cheerful little dinosaur who loves making new friends.', 'Animals'),
  ('Robo Bobo', 'A curious robot who loves building and inventing new things.', 'Sci-Fi'),
  ('Fairy Nila', 'A magical fairy who grants wishes with a sprinkle of stardust.', 'Fantasy'),
  ('Professor Panda', 'A wise panda teacher who makes learning fun and exciting.', 'Education'),
  ('Mimi the Magic Cat', 'A playful cat with magical powers and a love for adventure.', 'Fantasy'),
  ('Leo the Brave Lion', 'A courageous lion who protects his friends with a warm heart.', 'Animals'),
  ('Sunny Space Explorer', 'An enthusiastic astronaut who discovers new worlds and makes friends among the stars.', 'Sci-Fi'),
  ('Wally the Wizard', 'A friendly wizard who cooks up magical potions and silly spells.', 'Fantasy')
) AS v(name, description, category)
WHERE NOT EXISTS (
  SELECT 1 FROM public.characters c WHERE c.name = v.name
);

COMMENT ON TABLE public.characters IS
  'Original Cartoona characters. Seeded from config/characters.ts by '
  '20260918130000; the creation forms render that same list and the request '
  'RPC resolves the chosen name against this table.';
