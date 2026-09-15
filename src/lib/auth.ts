/**
 * GitHub Device Flow でのサインイン。
 *
 * なぜ Device Flow なのか:
 *   通常の OAuth（認可コードフロー）はトークン交換に client_secret が要る。拡張機能は
 *   コードを配布する以上 secret を隠せないので使えない。Device Flow は secret を使わない
 *   前提で設計されていて（gh CLI と同じ方式）、サーバーを一切持たずに完結する。
 *
 * 必要なもの: OAuth App の Client ID だけ（公開してよい値）。
 *             アプリ設定で "Enable Device Flow" を有効にしておくこと。
 */

import type { AuthScope } from './types.js';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const VERIFY_URL = 'https://github.com/login/device';

export const SCOPES: Record<AuthScope, { value: AuthScope; label: string }> = {
  repo: { value: 'repo', label: 'private リポジトリの PR も含める' },
  public_repo: { value: 'public_repo', label: 'public リポジトリのみ' },
};

/** GitHub が返すエラーコードを日本語にする。原因ごとに打つ手が違うので個別に書く。 */
const MESSAGES: Record<string, string> = {
  device_flow_disabled:
    'この OAuth App で Device Flow が有効になっていません。App の設定で "Enable Device Flow" にチェックを入れてください。',
  incorrect_client_credentials: 'Client ID が正しくありません。',
  Not_Found: 'Client ID に対応する OAuth App が見つかりません。値を確認してください。',
  expired_token: '承認の待ち時間（15 分）を過ぎました。もう一度やり直してください。',
  access_denied: '承認がキャンセルされました。',
  incorrect_device_code: 'デバイスコードが無効です。もう一度やり直してください。',
  unsupported_grant_type: 'リクエストの形式が正しくありません。',
};

/** GitHub の応答（エラー時は error / error_description が入る）。 */
interface GitHubAuthResponse {
  error?: string;
  error_description?: string;
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: number | string;
  expires_in?: number | string;
  access_token?: string;
  scope?: string;
}

const describe = (json: GitHubAuthResponse | null, res?: Response): string =>
  (json?.error ? MESSAGES[json.error] : undefined) ??
  (json?.error ? MESSAGES[String(json.error).replace(/\s+/g, '_')] : undefined) ??
  json?.error_description ??
  json?.error ??
  `GitHub から予期しない応答がありました (HTTP ${res?.status})`;

async function post(
  url: string,
  body: Record<string, string>
): Promise<{ res: Response; json: GitHubAuthResponse | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as GitHubAuthResponse | null;
  return { res, json };
}

/** 手順 1 で発行されるもの。そのまま pollForToken に渡す。 */
export interface DeviceCode {
  clientId: string;
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresIn: number;
}

/** 手順 1: デバイスコードとユーザーコードを発行してもらう。 */
export async function requestDeviceCode(
  clientId: string,
  scope: AuthScope = 'repo'
): Promise<DeviceCode> {
  const { res, json } = await post(DEVICE_CODE_URL, { client_id: clientId, scope });
  if (!json?.device_code) throw new Error(describe(json, res));
  const userCode = json.user_code ?? '';
  return {
    // 手順 3 のポーリングでも同じ Client ID が要るので一緒に持たせる
    clientId,
    deviceCode: json.device_code,
    userCode,
    // コードを前埋めした URL。GitHub 側で入力し直さずに済む
    verifyUrl: `${json.verification_uri || VERIFY_URL}?user_code=${encodeURIComponent(userCode)}`,
    interval: Math.max(5, Number(json.interval) || 5),
    expiresIn: Number(json.expires_in) || 900,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 手順 3: ユーザーが承認するまでポーリングする。
 * interval より短く投げると slow_down で怒られるので、言われたぶんだけ待ち時間を伸ばす。
 */
export async function pollForToken(
  { clientId, deviceCode, interval, expiresIn }: DeviceCode,
  onTick?: (secondsLeft: number) => void
): Promise<{ token: string; scope: string }> {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;

  while (Date.now() < deadline) {
    onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    await sleep(wait * 1000);

    const { res, json } = await post(TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (json?.access_token) return { token: json.access_token, scope: json.scope || '' };
    if (json?.error === 'authorization_pending') continue;
    if (json?.error === 'slow_down') {
      wait = Math.max(wait + 5, Number(json.interval) || wait + 5);
      continue;
    }
    throw new Error(describe(json, res));
  }
  throw new Error(MESSAGES['expired_token']);
}

/** サインアウト。GitHub 側の認可も併せて取り消したいときは設定ページへ誘導する。 */
export const REVOKE_URL = 'https://github.com/settings/applications';
