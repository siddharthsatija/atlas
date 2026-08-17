import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";
import type { Database } from "@/types/database.generated";

/**
 * A real finding for the E2E user (ATL-053 M5 support).
 *
 * ## Why this exists, and why it is a deliberate exception
 *
 * ATL-040's specs refuse to seed the database, on the grounds that a hand-built
 * finding would "prove the fixture works rather than the page". That reasoning
 * is right *for ATL-040*, whose subject is whether the Insights page faithfully
 * reflects what the product generated.
 *
 * ATL-053's subject is different: it is what the assistant does **given a
 * finding that already exists**. How that finding came to exist is not part of
 * the behaviour under test.
 *
 * The exception is narrowed so that it stays honest:
 *
 *   - The asset is created **through the product's own form**, not inserted.
 *   - The only direct write is one `asset_data_categories` row — the single step
 *     with no UI, because ATL-033 owns that surface and it is unbuilt.
 *   - `sensitivity` is **not supplied**. It is a generated column, so the
 *     database derives `high` from `financial`. The fixture cannot lie about it.
 *   - The finding itself is **never written**. The asset is re-saved through the
 *     product's edit form, which enqueues a recompute, and the real
 *     `FindingsEngine` evaluates R-003 and writes whatever it concludes.
 *
 * So nothing about `privacy_findings` is fabricated. If R-003 stops firing for
 * an active asset holding a high-sensitivity category, this fixture stops
 * producing a finding and the suite skips again — which is the correct
 * behaviour, because the precondition genuinely disappeared.
 *
 * ## Why R-003
 *
 * It is the only rule in the catalog with no time dependency. R-001 needs 180
 * days, R-005 needs 365, R-008 needs five assets sharing a category, and R-007's
 * table does not exist. R-003 fires on `active asset + ≥1 high-sensitivity
 * category`, which is reachable in a single test run.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export interface SeededFinding {
  assetId: string;
  serviceName: string;
}

function admin(): SupabaseClient<Database> {
  /**
   * Fails loudly rather than skipping. A fixture that quietly did nothing would
   * send every test back to the "no findings" skip, and the suite would report
   * green while asserting nothing — the exact failure this whole exercise was
   * about.
   */
  expect(
    SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY must be set for the ATL-053 finding fixture",
  ).not.toBe("");

  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Creates one asset through the UI, gives it one high-sensitivity category, and
 * lets the engine derive R-003.
 *
 * Returns the asset so the caller can tear it down. `privacy_findings` cascades
 * on `digital_assets` delete, so removing the asset removes the finding too.
 */
export async function seedSensitiveAsset(
  page: Page,
  /**
   * Distinguishes one spec's fixtures from another's in a shared account.
   *
   * Optional with the original default, so the existing ATL-053 call site is
   * unchanged in behaviour — its service names still begin "ATL053 Fixture
   * Bank", which is what its own locators scope on.
   */
  label = "ATL053 Fixture Bank",
): Promise<SeededFinding> {
  /**
   * Obviously synthetic, and unique per fixture (fixtures README rule 2).
   *
   * A random suffix as well as the clock: two workers can seed inside the same
   * millisecond, and a name collision would let one spec's locator resolve
   * another's card — the precise failure this fixture exists to prevent.
   */
  const serviceName = `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /** 1. The product's own creation flow. Enqueues the first recompute. */
  await page.goto("/assets/new");
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByLabel("Kind of service").selectOption("finance");
  await page.getByRole("button", { name: "Save service" }).click();

  /** The action redirects to the new asset, which is where its id comes from. */
  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
  const assetId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(assetId, "the create form should redirect to the new asset").not.toBe("");

  const db = admin();

  /** The owner is read from the row rather than decoded from the session. */
  const owner = await db.from("digital_assets").select("user_id").eq("id", assetId).single();
  expect(owner.error, `could not read the seeded asset: ${owner.error?.message ?? ""}`).toBeNull();
  const userId = owner.data?.user_id ?? "";

  /**
   * 2. The one direct write. `sensitivity` is omitted deliberately — the column
   *    is generated, so Postgres derives `high` from `financial` and the fixture
   *    has no way to assert a sensitivity the ADR does not agree with.
   */
  const category = await db
    .from("asset_data_categories")
    .insert({ user_id: userId, asset_id: assetId, category: "financial" })
    .select("sensitivity")
    .single();

  expect(
    category.error,
    `could not attach the data category: ${category.error?.message ?? ""}`,
  ).toBeNull();
  /** Proves the precondition R-003 actually reads, rather than assuming it. */
  expect(category.data?.sensitivity).toBe("high");

  /**
   * 3. Re-save through the product's edit form. This is what enqueues the
   *    recompute that the real engine acts on — the category was added after
   *    the creation recompute had already run.
   */
  await page.goto(`/assets/${assetId}/edit`);
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

  /**
   * 4. Confirm the **engine** produced a finding, and that it is R-003.
   *
   * Read-only: this asserts what the product concluded rather than creating
   * anything. Asserted here so a failure points at the fixture's precondition
   * rather than surfacing later as a mystifying skip in an assistant test.
   */
  await expect
    .poll(
      async () => {
        const findings = await db
          .from("privacy_findings")
          .select("source_reference")
          .eq("user_id", userId)
          .eq("asset_id", assetId);

        return (findings.data ?? []).map((row) => row.source_reference ?? "");
      },
      {
        message: "the findings engine should have derived R-003 from the seeded category",
        timeout: 15_000,
      },
    )
    .toContainEqual(expect.stringContaining("R-003"));

  return { assetId, serviceName };
}

/**
 * Removes everything the fixture created.
 *
 * One delete is enough: `asset_data_categories` and `privacy_findings` both
 * cascade on the asset's composite key, so the category and the derived finding
 * go with it. Deleting the finding separately would also work but would leave
 * the impression that findings are the fixture's to manage, and they are not.
 */
export async function removeSeededAsset(seeded: SeededFinding | null): Promise<void> {
  if (!seeded) return;

  const { error } = await admin().from("digital_assets").delete().eq("id", seeded.assetId);

  expect(error, `fixture teardown failed: ${error?.message ?? ""}`).toBeNull();
}
