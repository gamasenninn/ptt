// 汎用インフォメーション通知

const INFO_TOAST_DURATION = 5000;
const INFO_TOAST_MAX = 3;

const INFO_ICONS = {
    sensor: '\u{1F4E1}', alert: '\u26A0\uFE0F', announce: '\u{1F4E2}',
    system: '\u2699\uFE0F', default: '\u2139\uFE0F'
};

function handleInformation(data) {
    showInfoToast(data);
}

async function fetchLatestInformation() {
    try {
        const res = await fetch('/api/information/latest');
        if (!res.ok) return;
        const { items } = await res.json();
        for (const data of Object.values(items)) {
            showInfoToast(data);
        }
    } catch (e) {
        console.log('Failed to fetch information:', e.message);
    }
}

function showInfoToast(info) {
    let container = document.getElementById('infoToastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'infoToastContainer';
        container.className = 'info-toast-container';
        document.body.appendChild(container);
    }
    while (container.children.length >= INFO_TOAST_MAX) {
        container.removeChild(container.firstChild);
    }

    const icon = INFO_ICONS[info.category] || INFO_ICONS.default;
    const title = info.label || info.category;
    const body = info.message || JSON.stringify(info.value ?? '');

    const toast = document.createElement('div');
    toast.className = 'info-toast';
    toast.innerHTML =
        '<span class="info-toast-icon">' + icon + '</span>' +
        '<div class="info-toast-body">' +
            '<div class="info-toast-title">' + escapeInfoHtml(title) + '</div>' +
            '<div class="info-toast-text">' + escapeInfoHtml(body) + '</div>' +
        '</div>';
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.add('fade-out');
        toast.addEventListener('transitionend', () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        });
    }, INFO_TOAST_DURATION);
}

function escapeInfoHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
