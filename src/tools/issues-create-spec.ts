/**
 * Spec ↔ ticket helpers (Stage D) used by the `issues create` flow.
 *
 * Extracted from `issues-create.ts` so that file stays under the 400-line
 * cap. Barrel re-exported through `issues-create.ts` so existing import
 * paths keep working.
 */
import type { IndexedPage, KnowledgeBase } from "../lib/db.js";
import type { JiraClient } from "../lib/jira.js";

/**
 * Look up the source spec page in the KB.
 *
 * Returns undefined when nothing useful is found (page id absent, page not
 * indexed, or page belongs to a different source). Errors propagate so the
 * caller can surface them rather than silently dropping a misconfigured
 * source page reference.
 */
export function loadSourceSpec(
  kb: KnowledgeBase,
  sourcePageId?: string,
  sourcePageSource?: string,
): IndexedPage | undefined {
  if (!sourcePageId) return undefined;
  const page = kb.getPage(sourcePageId);
  if (!page) return undefined;
  const expected = sourcePageSource ?? "confluence";
  if (page.source !== expected) return undefined;
  return page;
}

/**
 * Persist a spec → issue link in the KB and best-effort attach a remote
 * link to the Jira issue so reviewers can navigate back to the spec.
 *
 * The Jira remote link is wrapped in try/catch — if the API call fails
 * (permissions, rate limit, etc.) the KB link is still recorded and the
 * caller's response is unaffected. Errors are surfaced via the returned
 * `remoteLinkError` so the caller can mention them in the response.
 */
export async function persistSpecLink(
  kb: KnowledgeBase,
  jira: InstanceType<typeof JiraClient>,
  issueKey: string,
  page: IndexedPage,
): Promise<{ remoteLinkError?: string }> {
  kb.upsertEpicSpecLink({
    issueKey,
    pageId: page.id,
    source: page.source,
    pageTitle: page.title,
    pageUrl: page.url,
  });

  if (!page.url) return {};
  try {
    await jira.addRemoteLink(issueKey, {
      url: page.url,
      title: page.title || `Spec ${page.id}`,
      summary: "Source spec for this work",
      relationship: "documented by",
      globalId: `lazy-backlog-spec-${page.source}-${page.id}`,
    });
    return {};
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[issues create] Failed to attach remote link for ${issueKey}: ${msg}`);
    return { remoteLinkError: msg };
  }
}

/**
 * If a source spec page is available, ensure the ticket description ends
 * with a "Source spec" reference line so the relationship is visible in
 * Jira even without the remote-link surface. Idempotent — no-ops when the
 * description already mentions the spec id.
 */
export function buildDescriptionWithSpecRef(
  description: string | undefined,
  sourceSpec: IndexedPage | undefined,
): string | undefined {
  if (!sourceSpec) return description;
  const ref = sourceSpec.url
    ? `Source spec: [${sourceSpec.title}](${sourceSpec.url}) (page ${sourceSpec.id})`
    : `Source spec: ${sourceSpec.title} (page ${sourceSpec.id})`;
  const base = description?.trim();
  if (base?.includes(`page ${sourceSpec.id}`)) return description;
  return base ? `${base}\n\n---\n${ref}` : ref;
}
