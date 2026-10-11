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

  async function readResponse(res, onStatus) {
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

  async function ask(url, body, options) {
    options = options || {};
    var doc = global.document;
    var el = options.statusEl || (doc && doc.getElementById("loading"));
    var label = findLabel(el);
    var original = label ? label.nodeValue : null;

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

      var data = await readResponse(res, onStatus);

      if (!data || (data.error && !data.answer)) {
        throw new Error(String((data && (data.message || data.error)) || "No response"));
      }
      return data;
    } finally {
      if (label && original !== null) label.nodeValue = original;
    }
  }

  global.CompaissStream = { ask: ask, readResponse: readResponse };
})(typeof window !== "undefined" ? window : globalThis);
