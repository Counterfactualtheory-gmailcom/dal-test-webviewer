/**
 * compaiss-stream-client.js
 * COMPAiSS Platform — shared browser client for Phase 1 live status streaming
 *
 * One call replaces fetch(...) + res.json() in any institution frontend:
 *
 *   const data = await CompaissStream.ask(ENDPOINT, { question, previousQuestion });
 *   safeRender(data.answer || '(no response)');
 *
 * - Sends { stream: true } so the server streams status events.
 * - Shows each status in the existing #loading element by replacing only its
 *   text label ("Answer coming"); the animated dots are left untouched.
 *   Status text is set with nodeValue/textContent, never innerHTML.
 * - Returns the final payload exactly as the server produced it (the same
 *   object res.json() used to return), so the existing safeRender() path is
 *   unchanged. Partial answers are never rendered.
 * - Falls back to plain JSON when the server or a request guard replies
 *   normally (e.g. rate limit), and to a single read on older webviews.
 * - Throws on server errors so the page's existing fallback message shows.
 * - Phase 2: if the server streams the answer (answer_chunk events), shows it
 *   growing in a temporary box inside #out (marked + DOMPurify, same as the
 *   page). The box is removed the moment the final answer arrives, so the
 *   page's own safeRender() still renders the final, fully sanitized answer.
 * - Diagnostics: after a question, window.CompaissStreamLog shows when each
 *   status and answer piece arrived (ms after Submit). Timing only, no content.
 */
(function (global) {
  "use strict";

  function parseBlock(block) {
    var evt = "message";
    var data = "";
    block.split(/\r?\n/).forEach(function (line) {
      if (line.indexOf("event:") === 0) evt = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
    });
    if (!data) return null;
    try {
      return { event: evt, data: JSON.parse(data) };
    } catch (e) {
      return null;
    }
  }

  async function readResponse(res, onStatus, onChunk) {
    var ct = (res.headers && res.headers.get("content-type")) || "";
    if (ct.indexOf("text/event-stream") === -1) {
      return await res.json();
    }

    var finalData = null;

    function handle(block) {
      var parsed = parseBlock(block);
      if (!parsed) return;
      if (parsed.event === "status") {
        if (parsed.data && parsed.data.text && onStatus) onStatus(String(parsed.data.text), parsed.data);
      } else if (parsed.event === "answer_chunk") {
        if (parsed.data && typeof parsed.data.text === "string" && onChunk) onChunk(parsed.data.text);
      } else if (parsed.event === "answer" || parsed.event === "error") {
        finalData = parsed.data;
        if (parsed.event === "error" && finalData && !finalData.error) {
          finalData.error = "Server error";
        }
      }
    }

    if (res.body && typeof res.body.getReader === "function" && typeof TextDecoder !== "undefined") {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
          handle(buf.slice(0, idx));
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        }
      }
      buf += decoder.decode();
      if (buf.trim()) handle(buf);
    } else {
      // Older webviews: statuses arrive together at the end, answer still works.
      (await res.text()).split(/\r?\n\r?\n/).forEach(handle);
    }

    return finalData || { error: "Stream ended without an answer" };
  }

  // Finds the "Answer coming" text label inside the loading element.
  function findLabel(el) {
    if (!el) return null;
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) return n;
    }
    return null;
  }

  // Temporary live answer box (Phase 2). Rendered with the page's own
  // marked + DOMPurify; never uses unsanitized HTML. Removed before the
  // final answer is handed back to the page.
  function createLiveAnswer(question) {
    var doc = global.document;
    var out = doc && doc.getElementById("out");
    if (!out || !global.marked || !global.DOMPurify) return null;

    var box = null;
    var text = "\u2753 Question:\n" + String(question || "") + "\n\n";
    var pending = false;
    var hadContent = !!out.innerHTML.trim();

    function render() {
      pending = false;
      if (!box) return;
      var cleaned = text
        .replace(/<+START\s*ANSWER[^>]*>+/gi, "")
        .replace(/<+END\s*ANSWER[^>]*>+/gi, "")
        .replace(/\[+COMPLETED+\]/gi, "")
        .replace(/\[+DONE+\]/gi, "");
      var html = global.DOMPurify.sanitize(global.marked.parse(cleaned), { ADD_ATTR: ["target", "rel"] });
      box.innerHTML = (hadContent ? '<div class="answer-divider"></div>' : "") + html;
      var links = box.querySelectorAll("a");
      for (var i = 0; i < links.length; i++) { links[i].target = "_blank"; links[i].rel = "noopener"; }
    }

    return {
      add: function (piece) {
        if (!box) {
          box = doc.createElement("div");
          box.setAttribute("data-compaiss-live", "1");
          out.setAttribute("aria-busy", "true"); // screen readers wait for the final answer
          out.appendChild(box);
          // The answer box sits above the text box, while the page has scrolled
          // down to the loading line. Bring the start of the new answer into view
          // once, so the student watches it grow (it then grows downward).
          try {
            if (typeof box.scrollIntoView === "function") {
              box.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          } catch (e) {}
        }
        text += piece;
        if (!pending) {
          pending = true;
          (global.requestAnimationFrame || function (f) { return setTimeout(f, 30); })(render);
        }
      },
      remove: function () {
        if (box && box.parentNode) box.parentNode.removeChild(box);
        box = null;
        out.removeAttribute("aria-busy");
      }
    };
  }

  async function ask(url, body, options) {
    options = options || {};
    var doc = global.document;
    var el = options.statusEl || (doc && doc.getElementById("loading"));
    var label = findLabel(el);
    var original = label ? label.nodeValue : null;

    var live = null;

    function onStatus(text, data) {
      if (label) label.nodeValue = text;
      if (typeof options.onStatus === "function") options.onStatus(text, data);
    }

    try {
      var res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        },
        body: JSON.stringify(Object.assign({}, body || {}, { stream: true })),
        signal: options.signal
      });

      live = options.liveAnswer === false ? null : createLiveAnswer(body && body.question);
      var log = global.CompaissStreamLog = { startedAt: Date.now(), statuses: [], chunks: [], finalAt: null };
      var data = await readResponse(res, function (text, d) {
        log.statuses.push({ ms: Date.now() - log.startedAt, text: text });
        onStatus(text, d);
      }, function (piece) {
        log.chunks.push({ ms: Date.now() - log.startedAt, chars: piece.length });
        if (live) live.add(piece);
        if (typeof options.onAnswerChunk === "function") options.onAnswerChunk(piece);
      });

      log.finalAt = Date.now() - log.startedAt;
      if (!data || (data.error && !data.answer)) {
        throw new Error(String((data && (data.message || data.error)) || "No response"));
      }
      return data;
    } finally {
      if (live) live.remove(); // final answer (or the page's error message) replaces it
      if (label && original !== null) label.nodeValue = original;
    }
  }

  global.CompaissStream = { ask: ask, readResponse: readResponse };
})(typeof window !== "undefined" ? window : globalThis);
