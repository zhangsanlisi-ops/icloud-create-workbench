import { detectRegion, REGION_CONFIG, STORAGE_KEY } from './cookie-utils.js';

const openButton = document.querySelector('#openButton');
const copyButton = document.querySelector('#copyButton');
const clearButton = document.querySelector('#clearButton');
const cookieOutput = document.querySelector('#cookieOutput');
const metaText = document.querySelector('#metaText');
const statusText = document.querySelector('#statusText');

let currentRecord = null;

function renderRecord(record, message = '') {
  currentRecord = record || null;
  cookieOutput.value = currentRecord?.cookie || '';
  copyButton.disabled = !currentRecord?.cookie;
  clearButton.disabled = !currentRecord?.cookie;

  if (!currentRecord) {
    metaText.textContent = '尚未捕获';
    setStatus(message || '请先打开 iCloud+ 的“隐藏邮件地址”，等待自动捕获 /v1|v2/hme 请求');
    return;
  }

  const regionLabel = REGION_CONFIG[currentRecord.region]?.label || '未知区域';
  const sourceLabel = currentRecord.source === 'request' ? 'HME接口捕获' : 'Cookie读取(不推荐)';
  const capturedAt = new Date(currentRecord.capturedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const account = currentRecord.accountHint ? ` · ${currentRecord.accountHint}` : '';
  metaText.textContent = `${regionLabel} · ${sourceLabel}${account} · ${capturedAt}`;
  setStatus(message || 'CK 已就绪', 'success');
}

function setStatus(message, type = '') {
  statusText.textContent = message;
  statusText.className = `status ${type}`.trim();
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || {};
}

async function openIcloudPlus() {
  const tab = await getCurrentTab();
  const region = detectRegion(tab.url);
  await chrome.tabs.create({ url: `${REGION_CONFIG[region].origin}/icloudplus/` });
}

async function copyCurrentCookie() {
  if (!currentRecord?.cookie) return;
  try {
    await navigator.clipboard.writeText(currentRecord.cookie);
  } catch {
    cookieOutput.select();
    document.execCommand('copy');
  }
  setStatus('CK 已复制；请粘贴到控制台对应 Apple ID 的“更新 CK”', 'success');
}

async function clearCurrentCookie() {
  await chrome.storage.local.remove(STORAGE_KEY);
  renderRecord(null, '本地 CK 已清除；现在重新打开“隐藏邮件地址”等自动捕获');
}

async function initialize() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  renderRecord(result[STORAGE_KEY] || null);
}

openButton.addEventListener('click', openIcloudPlus);
copyButton.addEventListener('click', copyCurrentCookie);
clearButton.addEventListener('click', clearCurrentCookie);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]) {
    renderRecord(changes[STORAGE_KEY].newValue || null, '已自动捕获隐藏邮箱接口 CK');
  }
});

initialize();
