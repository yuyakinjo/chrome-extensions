/** GitHub API クライアント。PAT が設定されているときだけ使う。 */

const REST = 'https://api.github.com';

export const apiHeaders = (token) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${token}`,
});

export async function fetchViewer(token) {
  try {
    const res = await fetch(`${REST}/user`, { headers: apiHeaders(token) });
    return res.ok ? (await res.json())?.login || null : null;
  } catch {
    return null;
  }
}

export async function fetchPrAuthor(pr, token) {
  try {
    const res = await fetch(`${REST}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
      headers: apiHeaders(token),
    });
    return res.ok ? (await res.json())?.user?.login || null : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ GraphQL

/** 認証が切れたことを呼び出し側が判別できるようにする。再接続を促すため。 */
export class AuthError extends Error {}

const authError = () =>
  new AuthError('GitHub の認証が切れています。接続し直してください。');

async function graphql(token, query) {
  const res = await fetch(`${REST}/graphql`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.status === 401) throw authError();
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(' / ').slice(0, 200));
  }
  return json.data;
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

function normalize(node) {
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

/** GraphQL が使えない環境（トークンの権限など）向けの簡易版。状態は取れない。 */
async function fetchMyOpenPrsViaSearch(token) {
  const q = encodeURIComponent('is:open is:pr author:@me archived:false');
  const res = await fetch(`${REST}/search/issues?q=${q}&per_page=100&sort=updated`, {
    headers: apiHeaders(token),
  });
  if (res.status === 401) throw authError();
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const items = ((await res.json()).items || []).map((i) => {
    const m = i.html_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return {
      key: m ? `${m[1]}#${m[2]}` : i.html_url,
      nwo: m ? m[1] : '',
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

export async function fetchMyOpenPrs(token) {
  try {
    const data = await graphql(token, MY_PRS_QUERY);
    return {
      items: (data.viewer.pullRequests.nodes || []).map(normalize),
      viewer: data.viewer.login,
      source: 'graphql',
    };
  } catch (e) {
    if (e instanceof AuthError) throw e; // 認証切れは検索 API でも同じなので即あきらめる
    // SSO 未認可や fine-grained token など GraphQL が通らない場合の保険
    const fallback = await fetchMyOpenPrsViaSearch(token).catch(() => null);
    if (fallback) return { ...fallback, degraded: e.message };
    throw e;
  }
}

/** 自分が動く必要がある PR か。バッジの色に使う。 */
export const needsAttention = (pr) =>
  pr.reviewDecision === 'CHANGES_REQUESTED' ||
  pr.checks === 'FAILURE' ||
  pr.checks === 'ERROR' ||
  pr.mergeable === 'CONFLICTING';
