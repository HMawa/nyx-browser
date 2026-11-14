'use strict';

/**
 * 安装包签名状态的判定（纯逻辑，零 Electron）。
 *
 * 为什么把判定单独放一个文件：
 *   「签名有效」「没签名」「签名过期」「读不出来」这四种状态必须对用户说清，
 *   而 PowerShell 读回来的又是字符串（Status=Valid / NotSigned / UnknownError），
 *   把这些字符串直接摊在界面上，用户只会看到一串英文。这里统一翻成中文，
 *   并且把「能不能信」的结论只在有证据时给出。
 */

const SIGNATURE_DEFAULT_WARN_DAYS = 30;
const SIGNATURE_LEVELS = {
  valid: 'valid',
  expiring: 'expiring',
  expired: 'expired',
  unsigned: 'unsigned',
  unknown: 'unknown',
};

const STATUS_LABELS = {
  valid: '签名有效',
  expiring: '签名有效（快过期）',
  expired: '签名已过期',
  unsigned: '没有签名',
  unknown: '读不出签名',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 把 PowerShell 的 NotAfter（可能是 ISO 字符串、"o" 格式、yyyy-MM-dd 或毫秒数）解析成毫秒。 */
function parseSignatureDate(raw) {
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw.getTime() : null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  // PowerShell 的 "o" 格式带 7 位小数秒，Date 解析不了，先削到毫秒
  const normalized = text.replace(/(\.\d{3})\d+/, '$1').replace(' ', 'T');
  const stamp = Date.parse(normalized);
  if (Number.isFinite(stamp) && stamp > 0) return stamp;
  const loose = Date.parse(text);
  return Number.isFinite(loose) && loose > 0 ? loose : null;
}

/**
 * 把 Get-AuthenticodeSignature 的结果翻成给人看的结论。
 *
 * 注意：notAfter 读不出来时**不算有效**——「我不知道它什么时候过期」和
 * 「它还没过期」是两件事，混在一起就会变成假安心。
 */
function describeSignature(input, options = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const warnDays = Number.isFinite(options.warnDays) && options.warnDays > 0
    ? options.warnDays
    : SIGNATURE_DEFAULT_WARN_DAYS;
  const status = typeof raw.status === 'string' ? raw.status.trim() : '';
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  const thumbprint = typeof raw.thumbprint === 'string' ? raw.thumbprint.trim() : '';
  const notAfter = parseSignatureDate(raw.notAfter);
  const daysLeft = notAfter === null ? null : Math.round((notAfter - now) / DAY_MS);

  const base = {
    ok: false,
    status: status || 'UnknownError',
    subject,
    thumbprint,
    notAfter: notAfter === null ? '' : new Date(notAfter).toISOString(),
    daysLeft,
  };

  if (status !== 'Valid') {
    // NotSigned 是「明确没有签名」，其余（HashMismatch / NotTrusted / UnknownError）
    // 都是「读到了但不可信」，这两种要分开说：前者是常态，后者是可疑。
    const unsigned = status === 'NotSigned';
    return {
      ...base,
      ok: false,
      level: unsigned ? SIGNATURE_LEVELS.unsigned : SIGNATURE_LEVELS.unknown,
      label: STATUS_LABELS[unsigned ? 'unsigned' : 'unknown'],
      suspicious: !unsigned,
      message: unsigned
        ? '这个可执行文件没有数字签名。自签名流程没跑过时这是正常的，但也意味着无法从文件本身判断它是否被改过。'
        : `签名状态是「${status || '未知'}」，也就是说签名存在但不可信（文件可能被改过，或证书不受信任）。请重新下载安装包。`,
    };
  }

  if (daysLeft === null) {
    return {
      ...base,
      ok: false,
      level: SIGNATURE_LEVELS.unknown,
      label: STATUS_LABELS.unknown,
      suspicious: false,
      message: '签名是有效的，但读不到证书有效期。读不到就不当作「还没过期」，请到 docs/Nyx-代码签名说明.md 里用 --status 复核。',
    };
  }

  if (daysLeft < 0) {
    return {
      ...base,
      ok: false,
      level: SIGNATURE_LEVELS.expired,
      label: STATUS_LABELS.expired,
      message: `签名证书已经过期 ${Math.abs(daysLeft)} 天。过期之后签出来的包会被系统当成无效签名，重新签名见 docs/Nyx-代码签名说明.md。`,
    };
  }

  if (daysLeft <= warnDays) {
    return {
      ...base,
      ok: true,
      level: SIGNATURE_LEVELS.expiring,
      label: STATUS_LABELS.expiring,
      message: `签名有效，但证书只剩 ${daysLeft} 天有效期（${base.notAfter.slice(0, 10)} 到期）。到期前重新签一份，别等它过期。`,
    };
  }

  return {
    ...base,
    ok: true,
    level: SIGNATURE_LEVELS.valid,
    label: STATUS_LABELS.valid,
    message: `签名有效，证书还有 ${daysLeft} 天有效期（${base.notAfter.slice(0, 10)} 到期）。自签名能证明文件没被改过，但不等于系统信任发布者。`,
  };
}

/** 解析 PowerShell 输出的 JSON（可能被包成数组、可能带 BOM）。 */
function parseSignaturePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '没读到签名信息（PowerShell 没有输出）。' };
  }
  const text = raw.replace(/^\uFEFF/, '').trim();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `签名信息不是合法的 JSON：${err && err.message ? err.message : '解析失败'}` };
  }
  const item = Array.isArray(data) ? data[0] : data;
  if (!item || typeof item !== 'object') {
    return { ok: false, error: '签名信息是空的（可能这个文件不存在）。' };
  }
  return {
    ok: true,
    value: {
      status: typeof item.Status === 'string' ? item.Status : '',
      subject: typeof item.Subject === 'string' ? item.Subject : '',
      thumbprint: typeof item.Thumbprint === 'string' ? item.Thumbprint : '',
      notAfter: item.NotAfter || '',
    },
  };
}

/** 界面上那一段可读文本：签名主体、指纹、到期日，缺项写「—」。 */
function describeSignatureFacts(described) {
  const info = described && typeof described === 'object' ? described : {};
  const notAfter = info.notAfter ? String(info.notAfter).slice(0, 10) : '';
  const days =
    Number.isFinite(info.daysLeft) ? (info.daysLeft < 0 ? `已过期 ${Math.abs(info.daysLeft)} 天` : `还有 ${info.daysLeft} 天`) : '';
  return [
    { label: '签名状态', value: info.status || '—' },
    { label: '结论', value: info.label || '—' },
    { label: '签名主体', value: info.subject || '—' },
    { label: '证书指纹', value: info.thumbprint || '—' },
    { label: '证书到期', value: notAfter ? `${notAfter}（${days || '—'}）` : '—' },
  ];
}

module.exports = {
  DAY_MS,
  SIGNATURE_DEFAULT_WARN_DAYS,
  SIGNATURE_LEVELS,
  STATUS_LABELS,
  describeSignature,
  describeSignatureFacts,
  parseSignatureDate,
  parseSignaturePayload,
};
