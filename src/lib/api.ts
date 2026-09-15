/** GitHub API クライアント。PAT が設定されているときだけ使う。 */

import type {
  CheckState,
  MergeableState,
  PrItem,
  PrRef,
  PrState,
  ReviewDecision,
} from './types.js';

const REST = 'https://api.github.com';

export const apiHeaders = (token: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${token}`,
});

export async function fetchViewer(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${REST}/user`, { headers: apiHeaders(token) });
    if (!res.ok) return null;
    const json = (await res.json()) as { login?: string } | null;
    return json?.login || null;
  } catch {
    return null;
  }
}

export async function fetchPrAuthor(pr: PrRef, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${REST}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
      headers: apiHeaders(token),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { user?: { login?: string } } | null;
    return json?.user?.login || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ GraphQL

/** 認証が切れたことを呼び出し側が判別できるようにする。再接続を促すため。 */
export class AuthError extends Error {}

const authError = () => new AuthError('GitHub の認証が切れています。接続し直してください。');

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(token: string, query: string): Promise<T> {
  const res = await fetch(`${REST}/graphql`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) throw authError();
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const json = (await res.json()) as GraphqlResponse<T>;
  if (json.errors?.length) {
    throw new Error(
      json.errors
        .map((e) => e.message)
        .join(' / ')
        .slice(0, 200)
    );
  }
  return json.data as T;
}

/**
 * 自分のオープン PR とその状態を 1 リクエストで取る。
 * レビュー状況・CI・コンフリクトまで含めたいので REST ではなく GraphQL を使う
 * （REST だと PR ごとに追加リクエストが要る）。
 */
const MY_PRS_QUERY = `
{
  viewer {
    login
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        repository { nameWithOwner }
        reviewDecision
        mergeable
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

interface MyPrNode {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  repository: { nameWithOwner: string };
  reviewDecision: ReviewDecision | null;
  mergeable: MergeableState | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: CheckState } } }> };
}

interface MyPrsData {
  viewer: { login: string; pullRequests: { nodes: MyPrNode[] | null } };
}

/** 取得結果。source は経路（GraphQL / 検索 API）、degraded は落ちた理由。 */
export interface MyPrsResult {
  items: PrItem[];
  viewer: string | null;
  source: 'graphql' | 'search';
  degraded?: string;
}

function normalize(node: MyPrNode): PrItem {
  return {
    key: `${node.repository.nameWithOwner}#${node.number}`,
    nwo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: !!node.isDraft,
    updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision ?? null, // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED
    mergeable: node.mergeable ?? null, // MERGEABLE / CONFLICTING / UNKNOWN
    checks: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  };
}

interface SearchIssue {
  html_url: string;
  title: string;
  draft?: boolean;
  updated_at: string;
}

/** GraphQL が使えない環境（トークンの権限など）向けの簡易版。状態は取れない。 */
async function fetchMyOpenPrsViaSearch(token: string): Promise<MyPrsResult> {
  const q = encodeURIComponent('is:open is:pr author:@me archived:false');
  const res = await fetch(`${REST}/search/issues?q=${q}&per_page=100&sort=updated`, {
    headers: apiHeaders(token),
  });
  if (res.status === 401) throw authError();
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const json = (await res.json()) as { items?: SearchIssue[] };
  const items = (json.items || []).map((i): PrItem => {
    const m = i.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return {
      key: m ? `${m[1]}#${m[2]}` : i.html_url,
      nwo: m ? m[1]! : '',
      number: m ? Number(m[2]) : 0,
      title: i.title,
      url: i.html_url,
      isDraft: !!i.draft,
      updatedAt: i.updated_at,
      reviewDecision: null,
      mergeable: null,
      checks: null,
    };
  });
  return { items, viewer: await fetchViewer(token), source: 'search' };
}

export async function fetchMyOpenPrs(token: string): Promise<MyPrsResult> {
  try {
    const data = await graphql<MyPrsData>(token, MY_PRS_QUERY);
    return {
      items: (data.viewer.pullRequests.nodes || []).map(normalize),
      viewer: data.viewer.login,
      source: 'graphql',
    };
  } catch (e) {
    if (e instanceof AuthError) throw e; // 認証切れは検索 API でも同じなので即あきらめる
    // SSO 未認可や fine-grained token など GraphQL が通らない場合の保険
    const fallback = await fetchMyOpenPrsViaSearch(token).catch(() => null);
    if (fallback) return { ...fallback, degraded: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

// ------------------------------------------------------------------ PR の状態確認

/** GraphQL のクエリに直接埋める値なので、GitHub が許す文字だけに絞る。 */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 指定した PR が今 OPEN / CLOSED / MERGED のどれなのかを `{key: state}` で返す。
 *
 * 「一覧から消えた」＝マージされた、と決めつけないために使う。open PR が 100 件を
 * 超えていたり取得が揺れたときも一覧からは消えるので、タブを閉じる前にここで確かめる。
 * 分からなかった PR は結果に入れない（呼び出し側が「不明」として扱えるように）。
 */
export async function fetchPrStates(
  prs: PrRef[],
  token: string
): Promise<Record<string, PrState>> {
  const targets = prs.filter(
    (p) => NAME_RE.test(p.owner || '') && NAME_RE.test(p.repo || '') && p.number > 0
  );
  if (!targets.length) return {};
  try {
    return await statesViaGraphql(targets, token);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return await statesViaRest(targets, token);
  }
}

/** 何件あっても 1 リクエストで済むよう、PR ごとに alias を振って束ねる。 */
async function statesViaGraphql(
  targets: PrRef[],
  token: string
): Promise<Record<string, PrState>> {
  const fields = targets.map(
    (p, i) =>
      `  p${i}: repository(owner: "${p.owner}", name: "${p.repo}") { pullRequest(number: ${p.number}) { state } }`
  );
  const data = await graphql<Record<string, { pullRequest?: { state?: PrState } } | null>>(
    token,
    `{\n${fields.join('\n')}\n}`
  );

  const out: Record<string, PrState> = {};
  targets.forEach((p, i) => {
    const state = data?.[`p${i}`]?.pullRequest?.state;
    if (state) out[p.key] = state; // OPEN / CLOSED / MERGED
  });
  return out;
}

/** GraphQL が通らないトークン向け。PR ごとに 1 リクエスト要るので、呼ぶ側で件数を絞る。 */
async function statesViaRest(targets: PrRef[], token: string): Promise<Record<string, PrState>> {
  const out: Record<string, PrState> = {};
  for (const p of targets) {
    const res = await fetch(`${REST}/repos/${p.owner}/${p.repo}/pulls/${p.number}`, {
      headers: apiHeaders(token),
    }).catch(() => null);
    if (!res) continue;
    if (res.status === 401) throw authError();
    if (!res.ok) continue; // 権限が無い / 消えたリポジトリなど。不明として扱う
    const json = (await res.json().catch(() => null)) as {
      merged?: boolean;
      state?: string;
    } | null;
    if (json) out[p.key] = json.merged ? 'MERGED' : json.state === 'closed' ? 'CLOSED' : 'OPEN';
  }
  return out;
}

/** 自分が動く必要がある PR か。バッジの色に使う。 */
export const needsAttention = (pr: PrItem): boolean =>
  pr.reviewDecision === 'CHANGES_REQUESTED' ||
  pr.checks === 'FAILURE' ||
  pr.checks === 'ERROR' ||
  pr.mergeable === 'CONFLICTING';
