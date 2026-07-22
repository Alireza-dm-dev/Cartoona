-- Migration: 00001_link_auth_users
-- Links public.users.id to auth.users.id as the source of truth for user identity.
-- Must be applied before any RLS policies or auth flows.

-- 1. Drop foreign keys that reference public.users.id so we can alter the primary key
ALTER TABLE public.parent_profiles DROP CONSTRAINT IF EXISTS parent_profiles_user_id_fkey;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_assigned_admin_id_fkey;
ALTER TABLE public.moderation_logs DROP CONSTRAINT IF EXISTS moderation_logs_moderator_id_fkey;

-- 2. Remove the gen_random_uuid() default; auth.users supplies the ID
ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;

-- 3. Link the app user row to the matching Supabase Auth user
ALTER TABLE public.users
  ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 4. Remove 'guest' from the role check constraint
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check CHECK (role IN ('parent', 'admin', 'super_admin'));

-- 5. Remove the UNIQUE constraint on email (auth.users.email already enforces uniqueness)
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_key;

-- 6. Create a security-definer function that inserts a public.users row when a new
--    auth.users row is created. The explicit search_path prevents search-path attacks.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, 'parent');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. Create the trigger on auth.users to fire after insert
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 8. Restore foreign keys that reference public.users.id
ALTER TABLE public.parent_profiles
  ADD CONSTRAINT parent_profiles_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id)
    REFERENCES public.users(id);
ALTER TABLE public.moderation_logs
  ADD CONSTRAINT moderation_logs_moderator_id_fkey FOREIGN KEY (moderator_id)
    REFERENCES public.users(id);
