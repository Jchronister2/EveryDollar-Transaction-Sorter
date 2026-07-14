// React Bridge — runs in MAIN world to access React's internal props on DOM elements.
// Content scripts run in an isolated world and cannot see __reactProps.
// This script reads transaction data from React and writes it to data-* attributes
// that the content script (isolated world) can read.

(function() {
    'use strict';

    function extractReactProps() {
        const cards = document.querySelectorAll('[data-testid="unallocated_card"]');
        let count = 0;
        for (const card of cards) {
            if (card.dataset.edbReactDate) continue; // already extracted
            try {
                const propsKey = Object.keys(card).find(k => k.startsWith('__reactProps'));
                if (!propsKey) continue;
                const children = card[propsKey]?.children;
                const innerProps = children?.props?.children;
                let tx = null;
                if (Array.isArray(innerProps)) {
                    tx = innerProps[0]?.props?.transaction;
                } else {
                    tx = innerProps?.props?.transaction;
                }
                if (tx) {
                    card.dataset.edbReactId = tx.id || '';
                    card.dataset.edbReactMerchant = tx.merchant || '';
                    card.dataset.edbReactAmount = String(tx.amount || 0);
                    // tx.date may be a Date object or string — always store as ISO
                    const d = tx.date;
                    card.dataset.edbReactDate = d instanceof Date ? d.toISOString() : (typeof d === 'string' ? d : String(d));
                    count++;
                }
            } catch(e) {}
        }
        return count;
    }

    // Run immediately
    extractReactProps();

    // Re-run on DOM mutations (new cards loaded)
    const observer = new MutationObserver(() => extractReactProps());
    const target = document.querySelector('[data-testid="transaction_collection"]') || document.body;
    observer.observe(target, { childList: true, subtree: true });

    // Expose for manual trigger from content script via custom event
    // Use document (shared between MAIN and ISOLATED worlds) not window (separate per world)
    document.addEventListener('edb-extract-react-props', () => {
        const count = extractReactProps();
        document.dispatchEvent(new CustomEvent('edb-react-props-extracted', { detail: { count } }));
    });

    console.log('[EDB React Bridge] Initialized in MAIN world');
})();
