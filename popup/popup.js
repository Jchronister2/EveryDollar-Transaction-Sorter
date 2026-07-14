// Popup Script
// Handles settings, store integration, and data management

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize
    await checkConnection();
    await loadSettings();
    await loadStorageStats();
    await loadKnowledgeGaps();
    await loadReceiptStats();

    // Set up event listeners
    setupEventListeners();
});

// Check connection to EveryDollar tab
async function checkConnection() {
    const statusEl = document.getElementById('connection-status');

    try {
        const tabs = await chrome.tabs.query({ url: '*://everydollar.com/*' });
        const wwwTabs = await chrome.tabs.query({ url: '*://www.everydollar.com/*' });
        const allTabs = [...tabs, ...wwwTabs];

        if (allTabs.length > 0) {
            // Try to communicate with content script
            try {
                const response = await chrome.tabs.sendMessage(allTabs[0].id, { action: 'getStatus' });
                statusEl.className = 'status-badge status-connected';
                statusEl.textContent = `Connected • ${response.transactionCount || 0} transactions`;

                // Enable action buttons
                document.getElementById('btn-scan').disabled = false;
                document.getElementById('btn-apply').disabled = false;
                document.getElementById('btn-learn').disabled = false;
            } catch (e) {
                statusEl.className = 'status-badge status-checking';
                statusEl.textContent = 'EveryDollar found - refresh page';
            }
        } else {
            statusEl.className = 'status-badge status-disconnected';
            statusEl.textContent = 'Open EveryDollar to start';
        }
    } catch (e) {
        statusEl.className = 'status-badge status-disconnected';
        statusEl.textContent = 'Error checking connection';
    }
}

// Load settings from storage
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get('settings');
        const settings = result.settings || {
            autoApplyHighConfidence: true,
            confidenceThreshold: 0.75,
            showNotifications: true
        };

        // Update UI
        const thresholdInput = document.getElementById('confidence-threshold');
        const thresholdValue = document.getElementById('confidence-value');
        thresholdInput.value = settings.confidenceThreshold * 100;
        thresholdValue.textContent = `${Math.round(settings.confidenceThreshold * 100)}%`;

        document.getElementById('auto-apply').checked = settings.autoApplyHighConfidence;
        document.getElementById('notifications').checked = settings.showNotifications;
    } catch (e) {
        console.error('Error loading settings:', e);
    }
}

// Save settings
async function saveSettings() {
    const settings = {
        confidenceThreshold: parseInt(document.getElementById('confidence-threshold').value) / 100,
        autoApplyHighConfidence: document.getElementById('auto-apply').checked,
        showNotifications: document.getElementById('notifications').checked
    };

    await chrome.storage.sync.set({ settings });
}

// Load storage statistics
async function loadStorageStats() {
    const statsEl = document.getElementById('storage-stats');
    console.log('Popup: Loading storage stats...');

    try {
        const response = await chrome.runtime.sendMessage({ action: 'getStorageStats' });
        console.log('Popup: Storage stats response:', response);

        if (!response || response.error) {
            throw new Error(response?.error || 'No response from background');
        }

        const syncPercent = response.sync.percentUsed;
        let barClass = '';
        if (syncPercent > 80) barClass = 'danger';
        else if (syncPercent > 60) barClass = 'warning';

        statsEl.innerHTML = `
      <div>
        <strong>Sync Storage:</strong> ${formatBytes(response.sync.bytesUsed)} / 100KB (${syncPercent}%)
        <div class="storage-bar">
          <div class="storage-bar-fill ${barClass}" style="width: ${syncPercent}%"></div>
        </div>
      </div>
      <div style="margin-top: 8px;">
        <strong>Local Storage:</strong> ${formatBytes(response.local.bytesUsed)} / 5MB
      </div>
    `;
    } catch (e) {
        console.error('Popup: Error loading storage stats:', e);
        statsEl.textContent = 'Unable to load storage stats';
    }
}

// Load knowledge gaps
async function loadKnowledgeGaps() {
    const gapsEl = document.getElementById('knowledge-gaps');
    console.log('Popup: Loading knowledge gaps...');

    try {
        const result = await chrome.storage.sync.get('knowledgeGaps');
        console.log('Popup: Knowledge gaps result:', result);
        const gaps = result.knowledgeGaps || [];

        if (gaps.length === 0) {
            gapsEl.innerHTML = '<span class="no-gaps">✓ No knowledge gaps detected</span>';
        } else {
            gapsEl.innerHTML = gaps.slice(0, 6).map(g =>
                `<span class="gap-item">${g}</span>`
            ).join('') + (gaps.length > 6 ? `<span class="gap-item">+${gaps.length - 6} more</span>` : '');
        }
    } catch (e) {
        console.error('Popup: Error loading knowledge gaps:', e);
        gapsEl.textContent = 'Unable to load';
    }
}

// Load receipt statistics
async function loadReceiptStats() {
    const statusEl = document.getElementById('receipts-status');

    try {
        let receipts = [];
        try {
            const syncResult = await chrome.storage.sync.get('storeReceipts');
            receipts = syncResult.storeReceipts || [];
        } catch {
            const localResult = await chrome.storage.local.get('storeReceipts');
            receipts = localResult.storeReceipts || [];
        }

        const counts = {
            target: 0,
            costco: 0,
            fredmeyer: 0
        };

        for (const r of receipts) {
            if (counts[r.store] !== undefined) {
                counts[r.store]++;
            }
        }

        if (receipts.length === 0) {
            statusEl.textContent = 'No receipts scraped yet';
        } else {
            statusEl.textContent = `📋 ${counts.target} Target • ${counts.costco} Costco • ${counts.fredmeyer} Fred Meyer`;
        }
    } catch (e) {
        statusEl.textContent = '';
    }
}

// Set up event listeners
function setupEventListeners() {
    // Action buttons
    document.getElementById('btn-scan').addEventListener('click', async () => {
        const btn = document.getElementById('btn-scan');
        btn.disabled = true;
        btn.textContent = '⏳ Scanning...';

        await sendToEveryDollar({ action: 'scan' });

        btn.disabled = false;
        btn.textContent = '🔄 Scan Transactions';
        await checkConnection();
    });

    document.getElementById('btn-apply').addEventListener('click', async () => {
        const btn = document.getElementById('btn-apply');
        btn.disabled = true;
        btn.textContent = '⏳ Applying...';

        await sendToEveryDollar({ action: 'applyAll' });

        btn.disabled = false;
        btn.textContent = '✓ Apply High-Confidence';
        await checkConnection();
    });

    document.getElementById('btn-learn').addEventListener('click', async () => {
        const btn = document.getElementById('btn-learn');
        btn.disabled = true;
        btn.textContent = '⏳ Learning...';

        await sendToEveryDollar({ action: 'learn' });

        btn.disabled = false;
        btn.textContent = '📚 Learn from Current Month';
        await loadKnowledgeGaps();
    });

    // Store buttons
    document.getElementById('btn-target').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openStoreTab', store: 'target' });
    });

    document.getElementById('btn-costco').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openStoreTab', store: 'costco' });
    });

    document.getElementById('btn-fredmeyer').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openStoreTab', store: 'fredmeyer' });
    });

    // Settings
    document.getElementById('confidence-threshold').addEventListener('input', (e) => {
        document.getElementById('confidence-value').textContent = `${e.target.value}%`;
        saveSettings();
    });

    document.getElementById('auto-apply').addEventListener('change', saveSettings);
    document.getElementById('notifications').addEventListener('change', saveSettings);

    // Data management
    document.getElementById('btn-export').addEventListener('click', async () => {
        const response = await chrome.runtime.sendMessage({ action: 'exportData' });

        const blob = new Blob([response.data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `everydollar-autobudget-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('btn-import').addEventListener('click', () => {
        document.getElementById('import-file').click();
    });

    document.getElementById('import-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const text = await file.text();
        const response = await chrome.runtime.sendMessage({ action: 'importData', data: text });

        if (response.success) {
            alert('Data imported successfully!');
            await loadStorageStats();
            await loadKnowledgeGaps();
            await loadReceiptStats();
        } else {
            alert(`Import failed: ${response.error}`);
        }

        e.target.value = '';
    });

    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all data? This cannot be undone.')) {
            return;
        }

        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();

        alert('All data cleared.');
        await loadStorageStats();
        await loadKnowledgeGaps();
        await loadReceiptStats();
    });

    // Help and feedback
    document.getElementById('btn-help').addEventListener('click', (e) => {
        e.preventDefault();
        alert(
            'EveryDollar Auto-Budget Help\n\n' +
            '1. Open EveryDollar and go to Transactions\n' +
            '2. Click the green button to see suggestions\n' +
            '3. Click "Apply All" to categorize in bulk\n' +
            '4. Use "Learn" to improve from past months\n' +
            '5. Scrape stores for itemized receipts\n\n' +
            'Right-click transactions to rename them.'
        );
    });

    document.getElementById('btn-feedback').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'mailto:feedback@example.com?subject=EveryDollar Auto-Budget Feedback' });
    });
}

// Send message to EveryDollar tab
async function sendToEveryDollar(message) {
    try {
        const tabs = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
        if (tabs.length > 0) {
            return await chrome.tabs.sendMessage(tabs[0].id, message);
        }
    } catch (e) {
        console.error('Error sending to EveryDollar:', e);
    }
    return null;
}

// Format bytes for display
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
