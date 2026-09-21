// @ts-check
//
// The viewer's front end. It owns the scrolling, the layout and the forms; it owns no knowledge of
// record formats or code pages - every row arrives already cut and already decoded, because that is
// where the file is, and because a webview is the last place to put a format's rules.
//
// Record bytes reach the DOM through textContent only. They are file contents, not markup.

(function () {
    const vscode = acquireVsCodeApi();

    /** Rows above and below the viewport that are fetched anyway, so scrolling does not flicker. */
    const OVERSCAN = 40;

    /** One request never asks for more than this - the extension refuses larger ones anyway. */
    const CHUNK = 200;

    /** The height of one line of the grid font. Rows are one, two or three of them. */
    const LINE_HEIGHT = 18;

    const state = {
        /** Records known so far; grows while the file is being counted. */
        count: 0,
        complete: false,
        size: 0,
        options: null,
        mode: 'text',
        /** index -> {index, offset, length, text, hex, truncated} */
        rows: new Map(),
        pending: new Set(),
        matches: [],
        matchSet: new Set(),
        matchAt: -1,
        filtered: false,
        rowHeight: 18,
        longestSeen: 80,
    };

    const dom = {
        toolbar: document.getElementById('toolbar'),
        viewMode: /** @type {HTMLSelectElement} */ (document.getElementById('view-mode')),
        goto: /** @type {HTMLInputElement} */ (document.getElementById('goto')),
        gotoButton: document.getElementById('goto-button'),
        searchValue: /** @type {HTMLInputElement} */ (document.getElementById('search-value')),
        searchKind: /** @type {HTMLSelectElement} */ (document.getElementById('search-kind')),
        searchCase: /** @type {HTMLInputElement} */ (document.getElementById('search-case')),
        searchButton: document.getElementById('search-button'),
        searchCancel: document.getElementById('search-cancel'),
        searchPrev: /** @type {HTMLButtonElement} */ (document.getElementById('search-prev')),
        searchNext: /** @type {HTMLButtonElement} */ (document.getElementById('search-next')),
        searchFilter: /** @type {HTMLInputElement} */ (document.getElementById('search-filter')),
        settingsButton: document.getElementById('settings-button'),
        settings: /** @type {HTMLFormElement} */ (document.getElementById('settings')),
        settingsNote: document.getElementById('settings-note'),
        recordFormat: /** @type {HTMLSelectElement} */ (document.getElementById('record-format')),
        recordLength: /** @type {HTMLInputElement} */ (document.getElementById('record-length')),
        vbHeader: /** @type {HTMLSelectElement} */ (document.getElementById('vb-header')),
        codePage: /** @type {HTMLSelectElement} */ (document.getElementById('code-page')),
        startOffset: /** @type {HTMLInputElement} */ (document.getElementById('start-offset')),
        lineEscape: /** @type {HTMLInputElement} */ (document.getElementById('line-escape')),
        settingsClose: document.getElementById('settings-close'),
        header: document.getElementById('header'),
        ruler: document.getElementById('ruler'),
        scroller: document.getElementById('scroller'),
        spacer: document.getElementById('spacer'),
        rows: document.getElementById('rows'),
        statusFile: document.getElementById('status-file'),
        statusCount: document.getElementById('status-count'),
        statusSearch: document.getElementById('status-search'),
        statusProblem: document.getElementById('status-problem'),
    };

    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'init': onInit(message); break;
            case 'count': onCount(message); break;
            case 'rows': onRows(message.rows); break;
            case 'rowsAt': onRows(message.rows); break;
            case 'searchProgress': onSearchProgress(message); break;
            case 'searchResult': onSearchResult(message); break;
            case 'error': onError(message.message); break;
        }
    });

    // --- incoming ---------------------------------------------------------------------------------

    function onInit(message) {
        state.options = message.options;
        state.size = message.size;
        state.rows.clear();
        state.pending.clear();
        state.count = 0;
        state.complete = false;
        clearSearch();

        fillSelect(dom.recordFormat, message.recordFormats.map(f => ({ value: f, label: f })));
        fillSelect(dom.vbHeader, message.vbHeaders.map(f => ({ value: f, label: vbHeaderLabel(f) })));
        fillSelect(dom.codePage, message.codePages.map(p => ({ value: p.id, label: p.label })));

        dom.recordFormat.value = message.options.recordFormat;
        dom.recordLength.value = String(message.options.recordLength);
        dom.vbHeader.value = message.options.vbHeader;
        dom.codePage.value = codePageValue(message.codePages, message.options.codePage);
        dom.startOffset.value = String(message.options.startOffset);
        dom.lineEscape.checked = message.options.lineSeqEscape === true;

        dom.settingsNote.textContent = settingsNote(message);
        dom.statusFile.textContent = statusFile(message);
        state.longestSeen = Math.max(message.options.recordLength || 80, 80);

        renderRuler();
        render(true);
    }

    function onCount(message) {
        state.count = message.known;
        state.complete = message.complete;

        dom.statusCount.textContent = message.complete
            ? plural(message.known, 'record')
            : plural(message.known, 'record') + ' so far, ' + percent(message.bytesScanned, state.size) + ' read';

        dom.statusProblem.textContent = message.problem
            ? 'Stopped at offset ' + message.problem.offset + ': ' + message.problem.message
            : '';

        render(false);
    }

    function onRows(rows) {
        for (const row of rows) {
            state.rows.delete(row.index);
            state.rows.set(row.index, row);
            state.pending.delete(row.index);
            if (row.length > state.longestSeen) state.longestSeen = row.length;
        }

        // The cache is a window on a file that may hold millions of records: keep it near what is on
        // screen rather than letting it grow into the whole file.
        while (state.rows.size > 4000) {
            const oldest = state.rows.keys().next();
            if (oldest.done) break;
            state.rows.delete(oldest.value);
        }

        renderRuler();
        render(false);
    }

    function onSearchProgress(message) {
        dom.statusSearch.textContent = 'Searching: ' + plural(message.matches, 'match', 'matches')
            + ' in ' + plural(message.scanned, 'record');
    }

    function onSearchResult(message) {
        dom.searchCancel.classList.add('hidden');
        dom.searchButton.classList.remove('hidden');

        state.matches = message.matches;
        state.matchSet = new Set(message.matches);
        state.matchAt = -1;

        const ending = message.complete ? '' : ' (stopped early)';
        dom.statusSearch.textContent = plural(message.matches.length, 'match', 'matches') + ending
            + (message.warning ? ' - ' + message.warning : '');

        const any = state.matches.length > 0;
        dom.searchPrev.disabled = !any;
        dom.searchNext.disabled = !any;
        dom.searchFilter.disabled = !any;

        // Only the filtered view's rows changed, so only it goes back to the top; a match jump
        // right after a scroll reset would be undone by it.
        render(state.filtered);

        if (any) goToMatch(0);
        else if (state.filtered) { dom.searchFilter.checked = false; setFiltered(false); }
    }

    function onError(text) {
        dom.statusProblem.textContent = text;
    }

    // --- rendering --------------------------------------------------------------------------------

    function rowCount() {
        return state.filtered ? state.matches.length : state.count;
    }

    function recordAt(rowIndex) {
        return state.filtered ? state.matches[rowIndex] : rowIndex;
    }

    /**
     * Lines per record: the text, and the two nibble lines under it. Hex is written vertically - the
     * high nibble above the low one, one byte per column - the way RecordEditor and ISPF write it, so a
     * byte sits exactly under its own character and the ruler counts columns for all three lines at once.
     */
    function linesPerRow() {
        return state.mode === 'text' ? 1 : state.mode === 'hex' ? 2 : 3;
    }

    function render(resetScroll) {
        state.rowHeight = LINE_HEIGHT * linesPerRow();
        dom.spacer.style.height = (rowCount() * state.rowHeight) + 'px';

        if (resetScroll) dom.scroller.scrollTop = 0;

        const viewport = dom.scroller.clientHeight || 400;
        const firstVisible = Math.floor(dom.scroller.scrollTop / state.rowHeight);
        const visible = Math.ceil(viewport / state.rowHeight);

        const first = Math.max(0, firstVisible - OVERSCAN);
        const last = Math.min(rowCount(), firstVisible + visible + OVERSCAN);

        requestMissing(first, last);
        paint(first, last);
    }

    function paint(first, last) {
        const fragment = document.createDocumentFragment();

        for (let rowIndex = first; rowIndex < last; rowIndex++) {
            const index = recordAt(rowIndex);
            const row = state.rows.get(index);
            const element = document.createElement('div');

            element.className = 'row';
            element.style.top = (rowIndex * state.rowHeight) + 'px';
            // Text and hex stack two lines into one row, so the height is the mode's, not the CSS default.
            element.style.height = state.rowHeight + 'px';
            if (!state.filtered && state.matchSet.has(index)) {
                element.classList.add('match');
            }

            append(element, 'col-number', String(index + 1));

            if (row) {
                append(element, 'col-offset', hexOffset(row.offset));
                append(element, 'col-length', String(row.length) + (row.truncated ? '!' : ''));

                const data = document.createElement('span');
                data.className = 'col-data';

                if (state.mode !== 'hex') appendLine(data, 'text', row.text);

                if (state.mode !== 'text') {
                    const nibbles = nibbleLines(row.hex);
                    appendLine(data, 'nibble hi', nibbles.hi);
                    appendLine(data, 'nibble lo', nibbles.lo);
                }

                element.appendChild(data);
            } else {
                append(element, 'col-offset', '');
                append(element, 'col-length', '');
                append(element, 'col-data loading', '');
            }

            fragment.appendChild(element);
        }

        dom.rows.replaceChildren(fragment);
    }

    function append(parent, className, text) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        parent.appendChild(span);
        return span;
    }

    function appendLine(parent, className, text) {
        const line = document.createElement('span');
        line.className = 'line ' + className;
        line.textContent = text;
        parent.appendChild(line);
    }

    /** The COBOL ruler, so a field's column can be counted off the screen. */
    function renderRuler() {
        const width = Math.min(Math.max(state.longestSeen, 80), 2048);
        let ruler = '';

        for (let column = 1; column <= width; column++) {
            if (column % 10 === 0) ruler += String((column / 10) % 10);
            else if (column % 5 === 0) ruler += '+';
            else ruler += '-';
        }

        dom.ruler.textContent = ruler;
    }

    function requestMissing(first, last) {
        /** @type {number[]} */
        const wanted = [];

        for (let rowIndex = first; rowIndex < last; rowIndex++) {
            const index = recordAt(rowIndex);
            if (index === undefined) continue;
            if (state.rows.has(index) || state.pending.has(index)) continue;
            wanted.push(index);
        }

        if (wanted.length === 0) return;
        for (const index of wanted) state.pending.add(index);

        if (state.filtered) {
            for (let i = 0; i < wanted.length; i += CHUNK) {
                vscode.postMessage({ type: 'rowsAt', indexes: wanted.slice(i, i + CHUNK) });
            }
            return;
        }

        // Contiguous view: ask for ranges, which the extension reads in one walk.
        let start = wanted[0];
        let previous = wanted[0];

        for (let i = 1; i <= wanted.length; i++) {
            const index = wanted[i];
            if (index === previous + 1 && index - start < CHUNK) { previous = index; continue; }
            vscode.postMessage({ type: 'rows', first: start, count: previous - start + 1 });
            start = index;
            previous = index;
        }
    }

    // --- events -----------------------------------------------------------------------------------

    dom.scroller.addEventListener('scroll', () => {
        dom.header.scrollLeft = dom.scroller.scrollLeft;
        render(false);
    });

    dom.viewMode.addEventListener('change', () => {
        state.mode = dom.viewMode.value;
        renderRuler();
        render(false);
    });

    dom.gotoButton.addEventListener('click', () => goToRecord(Number(dom.goto.value) - 1));
    dom.goto.addEventListener('keydown', event => {
        if (event.key === 'Enter') goToRecord(Number(dom.goto.value) - 1);
    });

    dom.searchButton.addEventListener('click', startSearch);
    dom.searchValue.addEventListener('keydown', event => { if (event.key === 'Enter') startSearch(); });
    dom.searchCancel.addEventListener('click', () => vscode.postMessage({ type: 'cancelSearch' }));
    dom.searchNext.addEventListener('click', () => goToMatch(state.matchAt + 1));
    dom.searchPrev.addEventListener('click', () => goToMatch(state.matchAt - 1));
    dom.searchFilter.addEventListener('change', () => setFiltered(dom.searchFilter.checked));

    dom.settingsButton.addEventListener('click', () => dom.settings.classList.toggle('hidden'));
    dom.settingsClose.addEventListener('click', () => dom.settings.classList.add('hidden'));

    dom.settings.addEventListener('submit', event => {
        event.preventDefault();

        vscode.postMessage({
            type: 'options',
            options: {
                recordFormat: dom.recordFormat.value,
                recordLength: Number(dom.recordLength.value),
                vbHeader: dom.vbHeader.value,
                codePage: dom.codePage.value,
                startOffset: Number(dom.startOffset.value),
                lineSeqEscape: dom.lineEscape.checked,
            },
        });

        dom.settings.classList.add('hidden');
    });

    window.addEventListener('resize', () => render(false));

    function startSearch() {
        const value = dom.searchValue.value;
        if (value.length === 0) return;

        dom.searchButton.classList.add('hidden');
        dom.searchCancel.classList.remove('hidden');
        dom.statusSearch.textContent = 'Searching...';

        vscode.postMessage({
            type: 'search',
            spec: {
                kind: dom.searchKind.value,
                value,
                caseInsensitive: dom.searchCase.checked,
                from: 0,
            },
        });
    }

    function clearSearch() {
        state.matches = [];
        state.matchSet = new Set();
        state.matchAt = -1;
        state.filtered = false;
        dom.searchFilter.checked = false;
        dom.searchFilter.disabled = true;
        dom.searchPrev.disabled = true;
        dom.searchNext.disabled = true;
        dom.statusSearch.textContent = '';
    }

    function setFiltered(filtered) {
        state.filtered = filtered;
        state.pending.clear();
        render(true);
    }

    function goToMatch(position) {
        if (state.matches.length === 0) return;

        const wrapped = (position + state.matches.length) % state.matches.length;
        state.matchAt = wrapped;

        goToRow(state.filtered ? wrapped : state.matches[wrapped]);
        dom.statusSearch.textContent = 'Match ' + (wrapped + 1) + ' of ' + state.matches.length
            + ' - record ' + (state.matches[wrapped] + 1);
    }

    function goToRecord(index) {
        if (!Number.isFinite(index) || index < 0) return;
        goToRow(state.filtered ? state.matches.indexOf(index) : index);
    }

    function goToRow(rowIndex) {
        if (rowIndex < 0) return;
        dom.scroller.scrollTop = Math.max(0, rowIndex * state.rowHeight - state.rowHeight * 3);
        render(false);
    }

    // --- small helpers ----------------------------------------------------------------------------

    function fillSelect(select, entries) {
        select.replaceChildren();

        for (const entry of entries) {
            const option = document.createElement('option');
            option.value = entry.value;
            option.textContent = entry.label;
            select.appendChild(option);
        }
    }

    function codePageValue(codePages, wanted) {
        const match = codePages.find(page => page.id === wanted || String(page.ccsid) === String(wanted));
        return match ? match.id : (codePages[0] && codePages[0].id) || '';
    }

    function vbHeaderLabel(format) {
        switch (format) {
            case 'auto': return 'Detect from the file';
            case 'mainframe': return 'Mainframe RDW (4 bytes)';
            case 'mf-short': return 'Micro Focus, short (2 bytes)';
            case 'mf-long': return 'Micro Focus, long (4 bytes)';
            default: return format;
        }
    }

    function settingsNote(message) {
        const resolved = message.resolved;
        const parts = [];

        if (resolved.kind === 'variable') {
            parts.push('Reading as ' + vbHeaderLabel(resolved.vbHeader).toLowerCase()
                + (resolved.startOffset > 0 ? ', records start at byte ' + resolved.startOffset : '') + '.');
        }
        if (resolved.kind === 'fixed') parts.push('Records are cut every ' + message.options.recordLength + ' bytes.');
        if (resolved.kind === 'line') parts.push('Records end at a line terminator in ' + resolved.codePageLabel + '.');
        if (resolved.carriageControl !== 'none') {
            parts.push('The first byte of each record is a ' + resolved.carriageControl + ' carriage-control character.');
        }
        if (message.metaPath) parts.push('Defaults came from ' + message.metaPath + '.');
        else parts.push('No .meta file beside this one: everything above is a guess you can correct.');

        if (resolved.fetchedWhole) {
            parts.push('This file came over ' + resolved.scheme + ', which hands over a whole file rather than '
                + 'the page being read, so all of it was fetched once. Later changes to it are not shown until '
                + 'the editor is reopened.');
        }

        return parts.join(' ');
    }

    function statusFile(message) {
        const name = message.dataSetName ? message.dataSetName + ' - ' + message.fileName : message.fileName;
        const where = message.resolved.fetchedWhole ? ' - over ' + message.resolved.scheme : '';
        return name + ' - ' + bytes(message.size) + where + ' - ' + message.options.recordFormat
            + ' - ' + message.resolved.codePageLabel;
    }

    /** `C1F0` becomes `CF` over `10`: one column per byte, aligned with the character above it. */
    function nibbleLines(hex) {
        let hi = '';
        let lo = '';

        for (let i = 0; i < hex.length; i += 2) {
            hi += hex[i];
            lo += hex[i + 1];
        }

        return { hi, lo };
    }

    function hexOffset(offset) {
        return offset.toString(16).toUpperCase().padStart(8, '0');
    }

    function plural(value, one, many) {
        return value.toLocaleString() + ' ' + (value === 1 ? one : (many || one + 's'));
    }

    function percent(part, whole) {
        if (!whole) return '0%';
        return Math.min(100, Math.floor((part / whole) * 100)) + '%';
    }

    function bytes(size) {
        if (size < 1024) return size + ' B';
        if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
        if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
        return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    vscode.postMessage({ type: 'ready' });
})();
