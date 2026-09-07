import { HomepageAdminTabs } from "@/components/admin/homepage/homepage-admin-tabs";
import { queryAdminHomepageContent } from "@/lib/admin/homepage/service";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * /admin/homepage — Phase 2 copy editor + Phase 3 media manager.
 *
 * Server component: loads the current content (or bundled defaults when the
 * CMS tables are absent) and hands it to the tabbed client UI. The public
 * homepage is untouched — nothing here is wired to runtime rendering
 * (wiring is Phase 4).
 */
export default async function AdminHomepagePage() {
  const supabase = await createServerSupabaseClient();
  const initial = await queryAdminHomepageContent(supabase);

  return (
    <HomepageAdminTabs
      initialContent={initial.content}
      initialRevision={initial.revision}
      isDefault={initial.isDefault}
    />
  );
}
