var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js
var init_event_stream = __esm({
  "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/api/lazy.js
var init_lazy = __esm({
  "node_modules/@earendil-works/pi-ai/dist/api/lazy.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/auth/context.js
var init_context = __esm({
  "node_modules/@earendil-works/pi-ai/dist/auth/context.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js
var init_credential_store = __esm({
  "node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/auth/helpers.js
var init_helpers = __esm({
  "node_modules/@earendil-works/pi-ai/dist/auth/helpers.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/utils/diagnostics.js
var init_diagnostics = __esm({
  "node_modules/@earendil-works/pi-ai/dist/utils/diagnostics.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/models-store.js
var init_models_store = __esm({
  "node_modules/@earendil-works/pi-ai/dist/models-store.js"() {
  }
});

// node_modules/@earendil-works/pi-ai/dist/models.js
var init_models = __esm({
  "node_modules/@earendil-works/pi-ai/dist/models.js"() {
  }
});

// node_modules/partial-json/dist/options.js
var require_options = __commonJS({
  "node_modules/partial-json/dist/options.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Allow = exports.ALL = exports.COLLECTION = exports.ATOM = exports.SPECIAL = exports.INF = exports._INFINITY = exports.INFINITY = exports.NAN = exports.BOOL = exports.NULL = exports.OBJ = exports.ARR = exports.NUM = exports.STR = void 0;
    exports.STR = 1;
    exports.NUM = 2;
    exports.ARR = 4;
    exports.OBJ = 8;
    exports.NULL = 16;
    exports.BOOL = 32;
    exports.NAN = 64;
    exports.INFINITY = 128;
    exports._INFINITY = 256;
    exports.INF = exports.INFINITY | exports._INFINITY;
    exports.SPECIAL = exports.NULL | exports.BOOL | exports.INF | exports.NAN;
    exports.ATOM = exports.STR | exports.NUM | exports.SPECIAL;
    exports.COLLECTION = exports.ARR | exports.OBJ;
    exports.ALL = exports.ATOM | exports.COLLECTION;
    exports.Allow = { STR: exports.STR, NUM: exports.NUM, ARR: exports.ARR, OBJ: exports.OBJ, NULL: exports.NULL, BOOL: exports.BOOL, NAN: exports.NAN, INFINITY: exports.INFINITY, _INFINITY: exports._INFINITY, INF: exports.INF, SPECIAL: exports.SPECIAL, ATOM: exports.ATOM, COLLECTION: exports.COLLECTION, ALL: exports.ALL };
    exports.default = exports.Allow;
  }
});

// node_modules/partial-json/dist/index.js
var require_dist = __commonJS({
  "node_modules/partial-json/dist/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Allow = exports.MalformedJSON = exports.PartialJSON = exports.parseJSON = exports.parse = void 0;
    var options_1 = require_options();
    Object.defineProperty(exports, "Allow", { enumerable: true, get: function() {
      return options_1.Allow;
    } });
    __exportStar(require_options(), exports);
    var PartialJSON = class extends Error {
    };
    exports.PartialJSON = PartialJSON;
    var MalformedJSON = class extends Error {
    };
    exports.MalformedJSON = MalformedJSON;
    function parseJSON(jsonString, allowPartial = options_1.Allow.ALL) {
      if (typeof jsonString !== "string") {
        throw new TypeError(`expecting str, got ${typeof jsonString}`);
      }
      if (!jsonString.trim()) {
        throw new Error(`${jsonString} is empty`);
      }
      return _parseJSON(jsonString.trim(), allowPartial);
    }
    exports.parseJSON = parseJSON;
    var _parseJSON = (jsonString, allow) => {
      const length = jsonString.length;
      let index = 0;
      const markPartialJSON = (msg) => {
        throw new PartialJSON(`${msg} at position ${index}`);
      };
      const throwMalformedError = (msg) => {
        throw new MalformedJSON(`${msg} at position ${index}`);
      };
      const parseAny = () => {
        skipBlank();
        if (index >= length)
          markPartialJSON("Unexpected end of input");
        if (jsonString[index] === '"')
          return parseStr();
        if (jsonString[index] === "{")
          return parseObj();
        if (jsonString[index] === "[")
          return parseArr();
        if (jsonString.substring(index, index + 4) === "null" || options_1.Allow.NULL & allow && length - index < 4 && "null".startsWith(jsonString.substring(index))) {
          index += 4;
          return null;
        }
        if (jsonString.substring(index, index + 4) === "true" || options_1.Allow.BOOL & allow && length - index < 4 && "true".startsWith(jsonString.substring(index))) {
          index += 4;
          return true;
        }
        if (jsonString.substring(index, index + 5) === "false" || options_1.Allow.BOOL & allow && length - index < 5 && "false".startsWith(jsonString.substring(index))) {
          index += 5;
          return false;
        }
        if (jsonString.substring(index, index + 8) === "Infinity" || options_1.Allow.INFINITY & allow && length - index < 8 && "Infinity".startsWith(jsonString.substring(index))) {
          index += 8;
          return Infinity;
        }
        if (jsonString.substring(index, index + 9) === "-Infinity" || options_1.Allow._INFINITY & allow && 1 < length - index && length - index < 9 && "-Infinity".startsWith(jsonString.substring(index))) {
          index += 9;
          return -Infinity;
        }
        if (jsonString.substring(index, index + 3) === "NaN" || options_1.Allow.NAN & allow && length - index < 3 && "NaN".startsWith(jsonString.substring(index))) {
          index += 3;
          return NaN;
        }
        return parseNum();
      };
      const parseStr = () => {
        const start = index;
        let escape = false;
        index++;
        while (index < length && (jsonString[index] !== '"' || escape && jsonString[index - 1] === "\\")) {
          escape = jsonString[index] === "\\" ? !escape : false;
          index++;
        }
        if (jsonString.charAt(index) == '"') {
          try {
            return JSON.parse(jsonString.substring(start, ++index - Number(escape)));
          } catch (e) {
            throwMalformedError(String(e));
          }
        } else if (options_1.Allow.STR & allow) {
          try {
            return JSON.parse(jsonString.substring(start, index - Number(escape)) + '"');
          } catch (e) {
            return JSON.parse(jsonString.substring(start, jsonString.lastIndexOf("\\")) + '"');
          }
        }
        markPartialJSON("Unterminated string literal");
      };
      const parseObj = () => {
        index++;
        skipBlank();
        const obj = {};
        try {
          while (jsonString[index] !== "}") {
            skipBlank();
            if (index >= length && options_1.Allow.OBJ & allow)
              return obj;
            const key = parseStr();
            skipBlank();
            index++;
            try {
              const value = parseAny();
              obj[key] = value;
            } catch (e) {
              if (options_1.Allow.OBJ & allow)
                return obj;
              else
                throw e;
            }
            skipBlank();
            if (jsonString[index] === ",")
              index++;
          }
        } catch (e) {
          if (options_1.Allow.OBJ & allow)
            return obj;
          else
            markPartialJSON("Expected '}' at end of object");
        }
        index++;
        return obj;
      };
      const parseArr = () => {
        index++;
        const arr = [];
        try {
          while (jsonString[index] !== "]") {
            arr.push(parseAny());
            skipBlank();
            if (jsonString[index] === ",") {
              index++;
            }
          }
        } catch (e) {
          if (options_1.Allow.ARR & allow) {
            return arr;
          }
          markPartialJSON("Expected ']' at end of array");
        }
        index++;
        return arr;
      };
      const parseNum = () => {
        if (index === 0) {
          if (jsonString === "-")
            throwMalformedError("Not sure what '-' is");
          try {
            return JSON.parse(jsonString);
          } catch (e) {
            if (options_1.Allow.NUM & allow)
              try {
                return JSON.parse(jsonString.substring(0, jsonString.lastIndexOf("e")));
              } catch (e2) {
              }
            throwMalformedError(String(e));
          }
        }
        const start = index;
        if (jsonString[index] === "-")
          index++;
        while (jsonString[index] && ",]}".indexOf(jsonString[index]) === -1)
          index++;
        if (index == length && !(options_1.Allow.NUM & allow))
          markPartialJSON("Unterminated number literal");
        try {
          return JSON.parse(jsonString.substring(start, index));
        } catch (e) {
          if (jsonString.substring(start, index) === "-")
            markPartialJSON("Not sure what '-' is");
          try {
            return JSON.parse(jsonString.substring(start, jsonString.lastIndexOf("e")));
          } catch (e2) {
            throwMalformedError(String(e2));
          }
        }
      };
      const skipBlank = () => {
        while (index < length && " \n\r	".includes(jsonString[index])) {
          index++;
        }
      };
      return parseAny();
    };
    var parse = parseJSON;
    exports.parse = parse;
  }
});

// node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js
var import_partial_json;
var init_json_parse = __esm({
  "node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js"() {
    import_partial_json = __toESM(require_dist(), 1);
  }
});

// src/main/core/telnet/TelnetClient.ts
import net from "node:net";
import { randomUUID } from "node:crypto";

// src/main/core/telnet/patterns.ts
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_TELNET_OPTIONS = {
  timeoutMs: 15e3,
  quietMs: 300,
  stallMs: 2e3,
  maxBytes: 512 * 1024,
  charDelayMs: 0,
  maxPagingHops: 200,
  disablePagingOnConnect: true,
  connectTimeoutMs: 1e4
};
var PROMPT_TAIL_RE = /(?:^|\n)[ \t]*([<[])([^\n<>[\]]{1,80})([>\]])[ \t]*$/;
var PROMPT_REJECT_RE = /[\s=,;:'"]/;
var VIEW_KEYWORDS = [
  {
    re: /(?:^|-)(?:gigabitethernet|ethernet|serial|vlanif|loopback|tunnel|meth|null|pos|virtual-template|inloopback)\d/i,
    view: "interface"
  },
  { re: /(?:^|-)vlan\d/i, view: "vlan" },
  { re: /(?:^|-)ospf/i, view: "ospf" },
  { re: /(?:^|-)acl/i, view: "acl" },
  {
    re: /(?:^|-)(?:rip|isis|bgp|aaa|ui|user-interface|radius|ip-pool|nat|dhcp|firewall|zone|policy|ike|ipsec|sysname)\b/i,
    view: "other"
  }
];
var PAGING_RE = /-{2,}\s*More\s*-{2,}/i;
var PAGING_TAIL_RE = /-{2,}\s*More\s*-{2,}[ \t]*$/i;
var CONFIRM_RE = /\[\s*[Yy]\s*\/\s*[Nn]\s*\]\s*[:：]?\s*$/;
var AUTH_RE = /(?:Username|Password)\s*[:：]\s*$/i;
var PAGING_ADVANCE = " ";
var ERROR_PATTERNS = [
  { re: /^\s*Error:\s*Unrecognized command/im, code: "UNRECOGNIZED", meaning: "\u547D\u4EE4\u4E0D\u5B58\u5728" },
  { re: /^\s*%\s*Unrecognized command/im, code: "UNRECOGNIZED", meaning: "\u547D\u4EE4\u4E0D\u5B58\u5728" },
  { re: /^\s*Error:\s*Incomplete command/im, code: "INCOMPLETE", meaning: "\u547D\u4EE4\u4E0D\u5B8C\u6574" },
  { re: /^\s*%\s*Incomplete command/im, code: "INCOMPLETE", meaning: "\u547D\u4EE4\u4E0D\u5B8C\u6574" },
  { re: /^\s*Error:\s*Ambiguous command/im, code: "AMBIGUOUS", meaning: "\u547D\u4EE4\u6709\u6B67\u4E49" },
  { re: /^\s*%\s*Ambiguous command/im, code: "AMBIGUOUS", meaning: "\u547D\u4EE4\u6709\u6B67\u4E49" },
  { re: /^\s*Error:\s*Wrong parameter/im, code: "BAD_PARAM", meaning: "\u53C2\u6570\u975E\u6CD5" },
  { re: /^\s*%\s*Wrong parameter/im, code: "BAD_PARAM", meaning: "\u53C2\u6570\u975E\u6CD5" },
  { re: /^\s*Error:\s*Too many parameters/im, code: "TOO_MANY_PARAMS", meaning: "\u53C2\u6570\u8FC7\u591A" },
  { re: /^\s*%\s*Invalid input detected/im, code: "INVALID_INPUT", meaning: "\u8F93\u5165\u975E\u6CD5" },
  {
    re: /^\s*Error:\s*The command is being executed,\s*please wait/im,
    code: "BUSY",
    meaning: "\u4E0A\u4E00\u6761\u547D\u4EE4\u5C1A\u672A\u6267\u884C\u5B8C"
  },
  { re: /^\s*Error:\s*You do not have permission/im, code: "NO_PERMISSION", meaning: "\u6743\u9650\u4E0D\u8DB3" },
  { re: /^\s*Error:\s*Permission denied/im, code: "NO_PERMISSION", meaning: "\u6743\u9650\u4E0D\u8DB3" },
  { re: /^\s*Error:\s*(?:Failed|Failure)\b/im, code: "FAILED", meaning: "\u64CD\u4F5C\u5931\u8D25" },
  { re: /^\s*Error:\s*\S/im, code: "FAILED", meaning: "\u547D\u4EE4\u6267\u884C\u62A5\u9519" }
];
var WARNING_RE = /^\s*Warning:/im;
var CARET_MARKER_RE = /^\s*\^+\s*$/m;
var IAC = 255;
var ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
var ANSI_OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
var ANSI_SINGLE_RE = /\u001b[@-Z\\-_]/g;
var REPLACEMENT_CHAR = "\uFFFD";

// src/main/core/telnet/cleaner.ts
function stripIac(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b !== IAC) {
      out[n++] = b;
      i++;
      continue;
    }
    if (i + 1 >= buf.length) break;
    const cmd = buf[i + 1];
    if (cmd === IAC) {
      out[n++] = IAC;
      i += 2;
      continue;
    }
    if (cmd === 250) {
      let j = i + 2;
      while (j + 1 < buf.length && !(buf[j] === IAC && buf[j + 1] === 240)) j++;
      i = j + 1 < buf.length ? j + 2 : buf.length;
      continue;
    }
    if (cmd >= 251 && cmd <= 254) {
      i += 3;
      continue;
    }
    i += 2;
  }
  return out.subarray(0, n);
}
function stripAnsi(text) {
  return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "").replace(ANSI_SINGLE_RE, "");
}
function applyBackspaces(text) {
  const out = [];
  for (const ch of text) {
    if (ch === "\b") {
      out.pop();
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function stripPagingMarkers(text) {
  return text.replace(new RegExp(PAGING_RE.source, "gi"), "");
}
function removeEchoLine(text, command) {
  const cmdKey = stripWhitespace(command);
  if (!cmdKey) return text;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return text;
  let acc = "";
  let j = i;
  while (j < lines.length) {
    const piece = stripWhitespace(lines[j]);
    if (piece === "") break;
    acc += piece;
    if (acc === cmdKey) {
      lines.splice(i, j - i + 1);
      return lines.join("\n");
    }
    if (!cmdKey.startsWith(acc)) break;
    j++;
  }
  return text;
}
function stripWhitespace(s) {
  return s.replace(/\s+/g, "");
}
function compressBlankLines(text) {
  return text.split("\n").reduce((acc, line) => {
    const blank = line.trim() === "";
    if (blank && acc.length > 0 && acc[acc.length - 1].trim() === "") return acc;
    acc.push(line);
    return acc;
  }, []).join("\n").trim();
}
function cleanResponse(raw, command) {
  let t = stripAnsi(raw);
  t = applyBackspaces(t);
  t = normalizeNewlines(t);
  t = stripPagingMarkers(t);
  t = removeEchoLine(t, command);
  t = compressBlankLines(t);
  return t;
}

// src/main/core/telnet/encoding.ts
var utf8Fatal = new TextDecoder("utf-8", { fatal: true });
var utf8Loose = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
var gbkDecoder = null;
var gbkProbed = false;
function getGbkDecoder() {
  if (!gbkProbed) {
    gbkProbed = true;
    try {
      const d = new TextDecoder("gbk", { fatal: false });
      if (d.decode(new Uint8Array([214, 208])) === "\u4E2D") gbkDecoder = d;
    } catch {
      gbkDecoder = null;
    }
  }
  return gbkDecoder;
}
function countReplacement(text) {
  let n = 0;
  for (const ch of text) if (ch === REPLACEMENT_CHAR) n++;
  return n;
}
function isAscii(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 127) return false;
  return true;
}
function isValidUtf8(buf) {
  try {
    utf8Fatal.decode(buf);
    return true;
  } catch {
    return false;
  }
}
function looksLikeMojibake(text) {
  let suspicious = 0;
  let nonAscii = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 128) continue;
    nonAscii++;
    if (c >= 1424 && c <= 1535 || c >= 1536 && c <= 1791) suspicious++;
  }
  return nonAscii >= 4 && suspicious / nonAscii > 0.3;
}
function detectEncodingDetailed(buf) {
  if (buf.length === 0) return { encoding: "utf8", confident: false };
  if (isAscii(buf)) return { encoding: "utf8", confident: false };
  if (isValidUtf8(buf)) {
    const text = utf8Loose.decode(buf);
    if (!looksLikeMojibake(text)) return { encoding: "utf8", confident: true };
    return getGbkDecoder() ? { encoding: "gbk", confident: true } : { encoding: "utf8", confident: true };
  }
  return getGbkDecoder() ? { encoding: "gbk", confident: true } : { encoding: "utf8", confident: true };
}
function detectEncoding(buf) {
  return detectEncodingDetailed(buf).encoding;
}
function decode(buf, encoding) {
  if (encoding === "gbk") {
    const d = getGbkDecoder();
    if (d) {
      const text3 = d.decode(buf);
      return { text: text3, encoding: "gbk", issues: countReplacement(text3) > 0 };
    }
    const text2 = utf8Loose.decode(buf);
    return { text: text2, encoding: "utf8", issues: countReplacement(text2) > 0 || !isAscii(buf) };
  }
  const text = utf8Loose.decode(buf);
  return { text, encoding: "utf8", issues: countReplacement(text) > 0 };
}
function tailSlice(buf, tailBytes) {
  if (buf.length <= tailBytes) return buf;
  let start = buf.length - tailBytes;
  while (start < buf.length && (buf[start] & 192) === 128) start++;
  return buf.subarray(start);
}
function probeEncodingSupport() {
  return { utf8: true, gbk: getGbkDecoder() !== null };
}

// src/main/core/telnet/errors.ts
function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim();
}
function detectError(text) {
  if (!text) return null;
  for (const p of ERROR_PATTERNS) {
    const m = p.re.exec(text);
    if (!m || m.index === void 0) continue;
    return {
      code: p.code,
      message: `${p.meaning}\uFF08${m[0].trim()}\uFF09`,
      line: lineAt(text, m.index),
      meaning: p.meaning
    };
  }
  return null;
}
function hasWarning(text) {
  return WARNING_RE.test(text);
}
function hasCaretMarker(text) {
  return CARET_MARKER_RE.test(text);
}

// src/main/core/telnet/prompt.ts
function extractView(rawContent) {
  const uncommitted = rawContent.startsWith("~");
  const body = uncommitted ? rawContent.slice(1) : rawContent;
  for (const kw of VIEW_KEYWORDS) {
    const m = kw.re.exec(body);
    if (!m) continue;
    const host = body.slice(0, m.index).replace(/-+$/, "");
    const suffix = body.slice(m.index).replace(/^-+/, "");
    return { host, suffix, view: kw.view, uncommitted };
  }
  return { host: body, suffix: "", view: null, uncommitted };
}
function matchPromptTail(tail, expectedHost) {
  const m = PROMPT_TAIL_RE.exec(tail);
  if (!m || m.index === void 0) return null;
  const open = m[1];
  const rawContent = m[2];
  const close = m[3];
  if (open === "<" && close !== ">") return null;
  if (open === "[" && close !== "]") return null;
  if (PROMPT_REJECT_RE.test(rawContent)) return null;
  const split = extractView(rawContent);
  if (!split.host) return null;
  if (expectedHost && split.host !== expectedHost) return null;
  const view = open === "<" ? "user" : split.view ?? "system";
  const info = {
    raw: `${open}${rawContent}${close}`,
    host: split.host,
    suffix: split.suffix,
    view,
    uncommitted: split.uncommitted
  };
  return { info, start: m.index };
}
function splitTrailingPrompt(text, expectedHost) {
  const match = matchPromptTail(text, expectedHost);
  if (!match) return { body: text, prompt: null };
  return { body: text.slice(0, match.start), prompt: match.info };
}
var VIEW_LABELS = {
  user: "\u7528\u6237\u89C6\u56FE",
  system: "\u7CFB\u7EDF\u89C6\u56FE",
  interface: "\u63A5\u53E3\u89C6\u56FE",
  vlan: "VLAN \u89C6\u56FE",
  ospf: "OSPF \u89C6\u56FE",
  acl: "ACL \u89C6\u56FE",
  other: "\u5176\u4ED6\u89C6\u56FE"
};
function viewLabel(view) {
  return VIEW_LABELS[view];
}

// src/main/core/telnet/TelnetClient.ts
var MAX_QUEUE = 100;
var DETECT_WINDOW = 4096;
function lastVisibleLine(text) {
  const trimmed = text.replace(/\s+$/, "");
  const idx = trimmed.lastIndexOf("\n");
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed).trim();
}
var TelnetClient = class {
  sock = null;
  opts;
  encodingPref;
  encoding = "utf8";
  encodingLocked = false;
  hostname = null;
  queue = [];
  active = null;
  closed = false;
  closeReason = "";
  // 当前命令的累积缓冲：head 保留前段，tail 滚动保留后段，便于截断时头尾都留
  head = [];
  headLen = 0;
  tail = [];
  tailLen = 0;
  totalLen = 0;
  truncated = false;
  // 交互通道按行累积
  interactiveLine = "";
  rawSubs = /* @__PURE__ */ new Set();
  closeSubs = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.opts = { ...DEFAULT_TELNET_OPTIONS, ...options };
    this.encodingPref = options.encoding ?? "auto";
  }
  // ———————————————————————————— 对外接口 ————————————————————————————
  get isClosed() {
    return this.closed;
  }
  get queueLength() {
    return this.queue.length + (this.active ? 1 : 0);
  }
  onRawData(cb) {
    this.rawSubs.add(cb);
    return () => this.rawSubs.delete(cb);
  }
  onClose(cb) {
    this.closeSubs.add(cb);
    return () => this.closeSubs.delete(cb);
  }
  async connect(port) {
    if (this.sock) throw new Error("\u5DF2\u7ECF\u8FDE\u63A5");
    const sock = net.createConnection({ host: DEFAULT_HOST, port });
    sock.setNoDelay(true);
    this.sock = sock;
    await new Promise((resolve, reject) => {
      const onErr = (e) => {
        cleanup();
        reject(e);
      };
      const onConn = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        sock.off("error", onErr);
        sock.off("connect", onConn);
      };
      sock.once("error", onErr);
      sock.once("connect", onConn);
    });
    sock.on("data", (chunk) => this.handleData(chunk));
    sock.on("error", (e) => this.shutdown(`\u8FDE\u63A5\u9519\u8BEF\uFF1A${e.message}`));
    sock.on("close", () => this.shutdown("\u8FDE\u63A5\u5DF2\u5173\u95ED"));
    const hs = await this.enqueue({
      kind: "handshake",
      command: "",
      timeoutMs: this.opts.connectTimeoutMs
    });
    const m = matchPromptTail(stripAnsi(decode(this.combined(), this.encoding).text));
    if (!m) {
      this.close();
      const reason = hs.awaitingConfirm ? "\u8BBE\u5907\u8981\u6C42\u8BA4\u8BC1\uFF08Username/Password\uFF09" : "\u672A\u80FD\u5728\u8D85\u65F6\u5185\u8BFB\u5230\u63D0\u793A\u7B26";
      throw new Error(reason);
    }
    this.hostname = m.info.host;
    let pagingDisabled = false;
    if (this.opts.disablePagingOnConnect) {
      try {
        const r = await this.exec("screen-length 0 temporary", { timeoutMs: 5e3 });
        pagingDisabled = r.ok && !r.errorCode;
      } catch {
        pagingDisabled = false;
      }
    }
    return {
      banner: cleanResponse(hs.clean, ""),
      prompt: m.info,
      encoding: this.encoding,
      pagingDisabled,
      // 关分页失败不代表分页不可用，只是需要走自动续读兜底
      pagingSupport: pagingDisabled
    };
  }
  /** 程序通道：给代理 / 工具层用，返回清洗后的结构化结果 */
  exec(command, opts = {}) {
    if (this.closed) {
      return Promise.resolve(this.synthetic("CLOSED", "\u8FDE\u63A5\u5DF2\u5173\u95ED"));
    }
    if (this.queue.length >= MAX_QUEUE) {
      return Promise.resolve(this.synthetic("UNKNOWN", `\u547D\u4EE4\u961F\u5217\u5DF2\u6EE1\uFF08${MAX_QUEUE}\uFF09\uFF0C\u62D2\u7EDD\u5165\u961F`));
    }
    return this.enqueue({
      kind: "program",
      command,
      timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
      signal: opts.signal
    });
  }
  /**
   * 交互通道：给 xterm 终端用。
   *
   * 行为规则（TELNET-SPEC.md §11）：
   * - 未按回车前：若当前有程序命令在执行，则缓冲不发送（避免代理命令与用户输入串在一行）；
   *   否则立即写 socket，保持正常终端手感。
   * - 按下回车：整行作为一条交互命令入队，与代理命令共用同一条串行队列，不享有插队特权。
   */
  writeInteractive(data) {
    if (this.closed) return { accepted: false, queued: false };
    const hasNewline = /[\r\n]/.test(data);
    const programRunning = this.active?.item.kind === "program";
    if (!hasNewline) {
      if (programRunning) {
        this.interactiveLine += data;
        return { accepted: true, queued: true };
      }
      this.interactiveLine += data;
      this.sock?.write(data);
      return { accepted: true, queued: false };
    }
    const line = this.interactiveLine + data.replace(/[\r\n]+$/, "");
    this.interactiveLine = "";
    if (!line.trim()) {
      this.sock?.write("\r\n");
      return { accepted: true, queued: false };
    }
    this.enqueue({ kind: "interactive", command: line, timeoutMs: this.opts.timeoutMs });
    return { accepted: true, queued: programRunning || this.queue.length > 0 };
  }
  close() {
    if (this.closed) return;
    this.shutdown("\u4E3B\u52A8\u65AD\u5F00");
  }
  // ———————————————————————————— 队列 ————————————————————————————
  enqueue(partial) {
    return new Promise((resolve, reject) => {
      const item = {
        id: randomUUID(),
        kind: partial.kind,
        command: partial.command,
        enqueuedAt: Date.now(),
        timeoutMs: partial.timeoutMs,
        resolve,
        reject,
        signal: partial.signal
      };
      this.queue.push(item);
      this.pump();
    });
  }
  pump() {
    if (this.closed || this.active || !this.sock) return;
    const item = this.queue.shift();
    if (!item) return;
    this.resetBuffer();
    const state = {
      item,
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      quietTimer: null,
      hardTimer: null,
      hops: 0,
      advancedAtLen: -1,
      abortHandler: null
    };
    this.active = state;
    if (item.signal) {
      const onAbort = () => {
        if (this.active === state) {
          this.resolveActive({ errorCode: "ABORTED", error: "\u547D\u4EE4\u88AB\u4E2D\u65AD" });
        }
      };
      item.signal.addEventListener("abort", onAbort, { once: true });
      state.abortHandler = onAbort;
      if (item.signal.aborted) {
        onAbort();
        return;
      }
    }
    state.hardTimer = setTimeout(() => {
      if (this.active === state) {
        this.resolveActive({ errorCode: "TIMEOUT", error: `\u547D\u4EE4\u8D85\u65F6\uFF08${item.timeoutMs}ms\uFF09` });
      }
    }, item.timeoutMs);
    if (item.command) this.writeCommand(item.command);
  }
  writeCommand(command) {
    if (!this.sock) return;
    const payload = `${command}\r
`;
    if (this.opts.charDelayMs > 0) {
      let i = 0;
      const tick = () => {
        if (!this.sock || this.closed || i >= payload.length) return;
        this.sock.write(payload[i]);
        i++;
        setTimeout(tick, this.opts.charDelayMs);
      };
      tick();
      return;
    }
    this.sock.write(payload);
  }
  // ———————————————————————————— 数据流入 ————————————————————————————
  handleData(chunk) {
    if (this.closed) return;
    const clean = stripIac(chunk);
    for (const cb of this.rawSubs) cb(new Uint8Array(clean));
    if (!this.active) return;
    this.active.lastDataAt = Date.now();
    this.append(clean);
    if (!this.encodingLocked) {
      if (this.encodingPref !== "auto") {
        this.encoding = this.encodingPref;
        this.encodingLocked = true;
      } else {
        const sample = this.combined().subarray(0, 65536);
        const verdict = detectEncodingDetailed(sample);
        this.encoding = verdict.encoding;
        if (verdict.confident) this.encodingLocked = true;
      }
    }
    this.armQuietTimer();
    this.evaluate();
  }
  append(chunk) {
    const halfLimit = Math.floor(this.opts.maxBytes / 2);
    this.totalLen += chunk.length;
    if (!this.truncated && this.totalLen > this.opts.maxBytes) {
      this.truncated = true;
    }
    if (this.truncated) {
      this.tail.push(chunk);
      this.tailLen += chunk.length;
      const keep = Math.max(halfLimit, DETECT_WINDOW);
      while (this.tailLen - (this.tail[0]?.length ?? 0) > keep && this.tail.length > 1) {
        const dropped = this.tail.shift();
        this.tailLen -= dropped.length;
      }
      return;
    }
    if (this.headLen < halfLimit) {
      this.head.push(chunk);
      this.headLen += chunk.length;
      return;
    }
    this.tail.push(chunk);
    this.tailLen += chunk.length;
  }
  resetBuffer() {
    this.head = [];
    this.headLen = 0;
    this.tail = [];
    this.tailLen = 0;
    this.totalLen = 0;
    this.truncated = false;
  }
  combined() {
    return Buffer.concat([...this.head, ...this.tail], this.headLen + this.tailLen);
  }
  armQuietTimer() {
    const state = this.active;
    if (!state) return;
    if (state.quietTimer) clearTimeout(state.quietTimer);
    state.quietTimer = setTimeout(() => {
      if (this.active !== state) return;
      this.onQuiet();
    }, this.opts.quietMs);
  }
  /** 静默兜底：弱判定 */
  onQuiet() {
    const state = this.active;
    if (!state) return;
    if (this.totalLen === 0) return;
    this.evaluate();
    if (this.active !== state) return;
    const text = decode(this.combined(), this.encoding).text;
    const hasContent = cleanResponse(text, state.item.command).trim().length > 0;
    const endsWithNewline = /[\r\n]$/.test(text);
    const stalled = Date.now() - state.lastDataAt >= this.opts.stallMs;
    if (hasContent && endsWithNewline || stalled) {
      this.resolveActive({ settled: "quiet" });
      return;
    }
    this.armQuietTimer();
  }
  // ———————————————————————————— 判定 ————————————————————————————
  evaluate() {
    const state = this.active;
    if (!state) return;
    const bytes = this.combined();
    const tailText = stripAnsi(decode(tailSlice(bytes, DETECT_WINDOW), this.encoding).text);
    if (PAGING_TAIL_RE.test(tailText)) {
      if (state.advancedAtLen !== this.totalLen && state.hops < this.opts.maxPagingHops) {
        state.hops++;
        state.advancedAtLen = this.totalLen;
        this.sock?.write(PAGING_ADVANCE);
        this.armQuietTimer();
      }
      return;
    }
    if (CONFIRM_RE.test(tailText)) {
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: lastVisibleLine(tailText),
        settled: "quiet"
      });
      return;
    }
    if (AUTH_RE.test(tailText)) {
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: lastVisibleLine(tailText),
        settled: "quiet"
      });
      return;
    }
    const m = matchPromptTail(tailText, this.hostname ?? void 0);
    if (m) {
      this.resolveActive({ settled: "prompt", prompt: m.info });
      return;
    }
    if (this.truncated) {
      this.resolveActive({ settled: "quiet" });
    }
  }
  resolveActive(over) {
    const state = this.active;
    if (!state) return;
    this.active = null;
    if (state.quietTimer) clearTimeout(state.quietTimer);
    if (state.hardTimer) clearTimeout(state.hardTimer);
    if (state.abortHandler && state.item.signal) {
      state.item.signal.removeEventListener("abort", state.abortHandler);
    }
    const result = this.buildResult(state, over);
    state.item.resolve(result);
    setImmediate(() => this.pump());
  }
  buildResult(state, over) {
    const ms = Date.now() - state.startedAt;
    const bytes = this.combined();
    const decoded = decode(bytes, this.encoding);
    const rawText = decoded.text;
    const { body, prompt } = splitTrailingPrompt(rawText, this.hostname ?? void 0);
    const clean = cleanResponse(body, state.item.kind === "handshake" ? "" : state.item.command);
    const errInfo = detectError(clean);
    const finalPrompt = over.prompt ?? prompt;
    let errorCode = over.errorCode;
    let error = over.error;
    let ok2 = true;
    if (errorCode) {
      ok2 = false;
    } else if (errInfo) {
      ok2 = false;
      errorCode = errInfo.code;
      error = errInfo.message;
    }
    if (this.truncated && ok2) {
      errorCode = errorCode ?? "TRUNCATED";
    }
    return {
      ok: ok2,
      clean,
      raw: rawText,
      prompt: finalPrompt?.raw ?? "",
      view: finalPrompt?.view ?? "other",
      settled: over.settled ?? "quiet",
      awaitingConfirm: over.awaitingConfirm ?? false,
      ...over.confirmText ? { confirmText: over.confirmText } : {},
      ...error ? { error } : {},
      ...errorCode ? { errorCode } : {},
      ...hasWarning(clean) ? { hasWarning: true } : {},
      ...this.truncated ? { truncated: true } : {},
      ...decoded.issues ? { decodeIssues: true } : {},
      ms
    };
  }
  synthetic(code, message) {
    return {
      ok: false,
      clean: "",
      raw: "",
      prompt: "",
      view: "other",
      settled: "quiet",
      awaitingConfirm: false,
      error: message,
      errorCode: code,
      ms: 0
    };
  }
  // ———————————————————————————— 生命周期 ————————————————————————————
  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const state = this.active;
    this.active = null;
    if (state) {
      if (state.quietTimer) clearTimeout(state.quietTimer);
      if (state.hardTimer) clearTimeout(state.hardTimer);
      const result = this.buildResult(state, { errorCode: "CLOSED", error: reason });
      state.item.resolve({ ...result, ok: false });
    }
    const pending = this.queue.splice(0, this.queue.length);
    for (const item of pending) {
      item.resolve(this.synthetic("CLOSED", reason));
    }
    try {
      this.sock?.destroy();
    } catch {
    }
    this.sock = null;
    for (const cb of this.closeSubs) cb(reason);
    this.rawSubs.clear();
  }
  get reason() {
    return this.closeReason;
  }
};

// src/shared/risk.ts
var DANGEROUS_COMMANDS = [
  "reboot",
  "reset saved-configuration",
  "reset current-configuration",
  "erase startup-config",
  "delete /unreserved",
  "format",
  "startup saved-configuration",
  "undo startup saved-configuration",
  "rollback configuration",
  "save",
  "factory-configuration"
];
var DANGEROUS_PATTERNS = [
  /^\s*undo\s+startup\b/i,
  /^\s*(clear|reset)\s+configuration\b/i,
  /^\s*delete\b.*\s\/unreserved\b/i,
  /^\s*stop\s+/i,
  /^\s*undo\s+save\b/i
];
var CONSEQUENCES = {
  reboot: "\u8BBE\u5907\u5C06\u91CD\u542F\uFF0C\u5F53\u524D\u5B9E\u9A8C\u4F1A\u8BDD\u4E2D\u65AD\uFF0C\u672A\u4FDD\u5B58\u7684\u914D\u7F6E\u4E22\u5931\u3002",
  "reset saved-configuration": "\u5C06\u6E05\u7A7A\u8BBE\u5907\u542F\u52A8\u914D\u7F6E\uFF0C\u8BBE\u5907\u91CD\u542F\u540E\u914D\u7F6E\u5168\u90E8\u4E22\u5931\u3002",
  "reset current-configuration": "\u5C06\u6E05\u7A7A\u8BBE\u5907\u5F53\u524D\u8FD0\u884C\u914D\u7F6E\uFF0C\u8BBE\u5907\u7ACB\u5373\u53D8\u4E3A\u521D\u59CB\u72B6\u6001\u3002",
  "erase startup-config": "\u5C06\u6E05\u7A7A\u8BBE\u5907\u542F\u52A8\u914D\u7F6E\u6587\u4EF6\uFF0C\u91CD\u542F\u540E\u914D\u7F6E\u4E22\u5931\u3002",
  "delete /unreserved": "\u5C06\u6C38\u4E45\u5220\u9664\u6587\u4EF6\uFF0C\u65E0\u6CD5\u4ECE\u56DE\u6536\u7AD9\u6062\u590D\u3002",
  format: "\u5C06\u683C\u5F0F\u5316\u8BBE\u5907\u5B58\u50A8\uFF0C\u5176\u4E2D\u6240\u6709\u6587\u4EF6\u4E22\u5931\u3002",
  "startup saved-configuration": "\u5C06\u6539\u53D8\u8BBE\u5907\u542F\u52A8\u65F6\u52A0\u8F7D\u7684\u914D\u7F6E\u6587\u4EF6\uFF0C\u53EF\u80FD\u4F7F\u91CD\u542F\u540E\u8FDB\u5165\u975E\u9884\u671F\u914D\u7F6E\u3002",
  "undo startup saved-configuration": "\u5C06\u79FB\u9664\u8BBE\u5907\u542F\u52A8\u914D\u7F6E\u6307\u5411\uFF0C\u91CD\u542F\u540E\u8BBE\u5907\u56DE\u5230\u51FA\u5382\u72B6\u6001\u3002",
  "rollback configuration": "\u5C06\u6574\u673A\u914D\u7F6E\u56DE\u9000\u5230\u5386\u53F2\u7248\u672C\uFF0C\u5F53\u524D\u6240\u6709\u914D\u7F6E\u88AB\u8986\u76D6\u3002",
  save: "\u5C06\u628A\u5F53\u524D\uFF08\u53EF\u80FD\u9519\u8BEF\u7684\uFF09\u8FD0\u884C\u914D\u7F6E\u56FA\u5316\u4E3A\u542F\u52A8\u914D\u7F6E\uFF0C\u4F7F\u9519\u8BEF\u6301\u4E45\u5316\u3002",
  "factory-configuration": "\u5C06\u6062\u590D\u8BBE\u5907\u51FA\u5382\u914D\u7F6E\uFF0C\u5168\u90E8\u914D\u7F6E\u4E22\u5931\u3002"
};
function classifyDanger(command) {
  const c = command.trim().replace(/\s+/g, " ").toLowerCase();
  if (!c) return { dangerous: false };
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(c)) {
      return {
        dangerous: true,
        reason: `\u547D\u4E2D\u7ED3\u6784\u89C4\u5219 ${pattern.source}`,
        consequence: "\u8BE5\u547D\u4EE4\u6D89\u53CA\u542F\u52A8\u914D\u7F6E\u6216\u4E0D\u53EF\u6062\u590D\u64CD\u4F5C\uFF0C\u6267\u884C\u540E\u53EF\u80FD\u65E0\u6CD5\u56DE\u9000\u3002"
      };
    }
  }
  for (const item of DANGEROUS_COMMANDS) {
    if (c === item || c.startsWith(item + " ")) {
      return {
        dangerous: true,
        reason: `\u547D\u4E2D\u5371\u9669\u547D\u4EE4\u6E05\u5355\uFF1A${item}`,
        consequence: CONSEQUENCES[item] ?? "\u8BE5\u547D\u4EE4\u5C5E\u4E8E\u7834\u574F\u6027\u64CD\u4F5C\uFF0C\u6267\u884C\u540E\u53EF\u80FD\u65E0\u6CD5\u56DE\u9000\u3002"
      };
    }
  }
  return { dangerous: false };
}
var READ_ONLY_PREFIXES = [
  "display",
  "show",
  "dir",
  "more",
  "ping",
  "tracert"
];
function isReadOnlyCommand(command) {
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return READ_ONLY_PREFIXES.includes(first);
}

// node_modules/typebox/build/system/memory/memory.mjs
var memory_exports = {};
__export(memory_exports, {
  Assign: () => Assign,
  Clone: () => Clone,
  Create: () => Create,
  Discard: () => Discard,
  Metrics: () => Metrics,
  Update: () => Update
});

// node_modules/typebox/build/system/memory/metrics.mjs
var Metrics = {
  assign: 0,
  create: 0,
  clone: 0,
  discard: 0,
  update: 0
};

// node_modules/typebox/build/system/memory/assign.mjs
function Assign(left, right) {
  Metrics.assign += 1;
  return { ...left, ...right };
}

// node_modules/typebox/build/guard/guard.mjs
var guard_exports = {};
__export(guard_exports, {
  Entries: () => Entries,
  EntriesRegExp: () => EntriesRegExp,
  Every: () => Every,
  EveryAll: () => EveryAll,
  GraphemeCount: () => GraphemeCount2,
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsClassInstance: () => IsClassInstance,
  IsConstructor: () => IsConstructor,
  IsDeepEqual: () => IsDeepEqual,
  IsEqual: () => IsEqual,
  IsFunction: () => IsFunction,
  IsGreaterEqualThan: () => IsGreaterEqualThan,
  IsGreaterThan: () => IsGreaterThan,
  IsInteger: () => IsInteger,
  IsLessEqualThan: () => IsLessEqualThan,
  IsLessThan: () => IsLessThan,
  IsMaxLength: () => IsMaxLength2,
  IsMinLength: () => IsMinLength2,
  IsMultipleOf: () => IsMultipleOf,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsObjectNotArray: () => IsObjectNotArray,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUndefined: () => IsUndefined,
  IsUnsafePropertyKey: () => IsUnsafePropertyKey,
  IsValueLike: () => IsValueLike,
  Keys: () => Keys,
  ShiftLeft: () => ShiftLeft,
  Symbols: () => Symbols,
  Values: () => Values
});

// node_modules/typebox/build/guard/string.mjs
function IsBetween(value, min, max) {
  return value >= min && value <= max;
}
function IsZeroWidthJoiner(value) {
  return value === 8205;
}
function IsHighSurrogate(value) {
  return IsBetween(value, 55296, 56319);
}
function IsRegionalIndicator(value) {
  return IsBetween(value, 127462, 127487);
}
function IsVariationSelector(value) {
  return IsBetween(value, 65024, 65039);
}
function IsCombiningMark(value) {
  return IsBetween(value, 768, 879) || IsBetween(value, 6832, 6911) || IsBetween(value, 7616, 7679) || IsBetween(value, 65056, 65071);
}
function CodePointLength(value) {
  return value > 65535 ? 2 : 1;
}
function ConsumeModifiers(value, index) {
  while (index < value.length) {
    const point = value.codePointAt(index);
    if (IsCombiningMark(point) || IsVariationSelector(point)) {
      index += CodePointLength(point);
    } else {
      break;
    }
  }
  return index;
}
function NextGraphemeClusterIndex(value, clusterStart) {
  const startCP = value.codePointAt(clusterStart);
  let clusterEnd = clusterStart + CodePointLength(startCP);
  clusterEnd = ConsumeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && value[clusterEnd] === "\u200D") {
    const nextCP = value.codePointAt(clusterEnd + 1);
    clusterEnd += 1 + CodePointLength(nextCP);
    clusterEnd = ConsumeModifiers(value, clusterEnd);
  }
  if (IsRegionalIndicator(startCP) && clusterEnd < value.length && IsRegionalIndicator(value.codePointAt(clusterEnd))) {
    clusterEnd += CodePointLength(value.codePointAt(clusterEnd));
  }
  return clusterEnd;
}
function IsGraphemeCodePoint(value) {
  return IsHighSurrogate(value) || IsCombiningMark(value) || IsVariationSelector(value) || IsZeroWidthJoiner(value);
}
function GraphemeCount(value) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
  }
  return count;
}
function IsMinLength(value, minLength) {
  if (minLength === 0)
    return true;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count >= minLength)
      return true;
  }
  return false;
}
function IsMaxLength(value, maxLength) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count > maxLength)
      return false;
  }
  return true;
}
function IsMinLengthFast(value, minLength) {
  if (minLength === 0)
    return true;
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMinLength(value, minLength);
    }
    index++;
    if (index >= minLength)
      return true;
  }
  return false;
}
function IsMaxLengthFast(value, maxLength) {
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMaxLength(value, maxLength);
    }
    index++;
    if (index > maxLength)
      return false;
  }
  return true;
}

// node_modules/typebox/build/guard/guard.mjs
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return IsEqual(typeof value, "bigint");
}
function IsBoolean(value) {
  return IsEqual(typeof value, "boolean");
}
function IsConstructor(value) {
  if (IsUndefined(value) || !IsFunction(value))
    return false;
  const result = Function.prototype.toString.call(value);
  if (/^class\s/.test(result))
    return true;
  if (/\[native code\]/.test(result))
    return true;
  return false;
}
function IsFunction(value) {
  return IsEqual(typeof value, "function");
}
function IsInteger(value) {
  return Number.isInteger(value);
}
function IsNull(value) {
  return IsEqual(value, null);
}
function IsNumber(value) {
  return Number.isFinite(value);
}
function IsObjectNotArray(value) {
  return IsObject(value) && !IsArray(value);
}
function IsObject(value) {
  return IsEqual(typeof value, "object") && !IsNull(value);
}
function IsString(value) {
  return IsEqual(typeof value, "string");
}
function IsSymbol(value) {
  return IsEqual(typeof value, "symbol");
}
function IsUndefined(value) {
  return IsEqual(value, void 0);
}
function IsEqual(left, right) {
  return left === right;
}
function IsGreaterThan(left, right) {
  return left > right;
}
function IsLessThan(left, right) {
  return left < right;
}
function IsLessEqualThan(left, right) {
  return left <= right;
}
function IsGreaterEqualThan(left, right) {
  return left >= right;
}
function IsMultipleOf(dividend, divisor) {
  if (IsBigInt(dividend) || IsBigInt(divisor)) {
    return BigInt(dividend) % BigInt(divisor) === 0n;
  }
  const tolerance = 1e-10;
  if (!IsNumber(dividend))
    return true;
  if (IsInteger(dividend) && 1 / divisor % 1 === 0)
    return true;
  const mod = dividend % divisor;
  return Math.min(Math.abs(mod), Math.abs(mod - divisor), Math.abs(mod + divisor)) < tolerance;
}
function IsClassInstance(value) {
  if (!IsObject(value))
    return false;
  const proto = globalThis.Object.getPrototypeOf(value);
  if (IsNull(proto))
    return false;
  return IsEqual(typeof proto.constructor, "function") && !(IsEqual(proto.constructor, globalThis.Object) || IsEqual(proto.constructor.name, "Object"));
}
function IsValueLike(value) {
  return IsBigInt(value) || IsBoolean(value) || IsNull(value) || IsNumber(value) || IsString(value) || IsUndefined(value);
}
function GraphemeCount2(value) {
  return GraphemeCount(value);
}
function IsMaxLength2(value, length) {
  return IsMaxLengthFast(value, length);
}
function IsMinLength2(value, length) {
  return IsMinLengthFast(value, length);
}
function Every(value, offset, callback) {
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      return false;
  }
  return true;
}
function EveryAll(value, offset, callback) {
  let result = true;
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      result = false;
  }
  return result;
}
function ShiftLeft(array, true_, false_) {
  return IsEqual(array.length, 0) ? false_() : true_(array[0], array.slice(1));
}
function IsUnsafePropertyKey(key) {
  return IsEqual(key, "__proto__") || IsEqual(key, "constructor") || IsEqual(key, "prototype");
}
function HasPropertyKey(value, key) {
  return IsUnsafePropertyKey(key) ? Object.prototype.hasOwnProperty.call(value, key) : key in value;
}
function EntriesRegExp(value) {
  return Keys(value).map((key) => [new RegExp(`^${key}$`), value[key]]);
}
function Entries(value) {
  return Object.entries(value);
}
function Keys(value) {
  return Object.getOwnPropertyNames(value);
}
function Symbols(value) {
  return Object.getOwnPropertySymbols(value);
}
function Values(value) {
  return Object.values(value);
}
function DeepEqualObject(left, right) {
  if (!IsObject(right))
    return false;
  const keys = Keys(left);
  return IsEqual(keys.length, Keys(right).length) && keys.every((key) => IsDeepEqual(left[key], right[key]));
}
function DeepEqualArray(left, right) {
  return IsArray(right) && IsEqual(left.length, right.length) && left.every((_, index) => IsDeepEqual(left[index], right[index]));
}
function IsDeepEqual(left, right) {
  return IsArray(left) ? DeepEqualArray(left, right) : IsObject(left) ? DeepEqualObject(left, right) : IsEqual(left, right);
}

// node_modules/typebox/build/guard/globals.mjs
var globals_exports = {};
__export(globals_exports, {
  IsBigInt64Array: () => IsBigInt64Array,
  IsBigUint64Array: () => IsBigUint64Array,
  IsBoolean: () => IsBoolean2,
  IsDate: () => IsDate,
  IsFloat32Array: () => IsFloat32Array,
  IsFloat64Array: () => IsFloat64Array,
  IsInt16Array: () => IsInt16Array,
  IsInt32Array: () => IsInt32Array,
  IsInt8Array: () => IsInt8Array,
  IsMap: () => IsMap,
  IsNumber: () => IsNumber2,
  IsRegExp: () => IsRegExp,
  IsSet: () => IsSet,
  IsString: () => IsString2,
  IsTypeArray: () => IsTypeArray,
  IsUint16Array: () => IsUint16Array,
  IsUint32Array: () => IsUint32Array,
  IsUint8Array: () => IsUint8Array,
  IsUint8ClampedArray: () => IsUint8ClampedArray
});
function IsBoolean2(value) {
  return value instanceof Boolean;
}
function IsNumber2(value) {
  return value instanceof Number;
}
function IsString2(value) {
  return value instanceof String;
}
function IsTypeArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsInt8Array(value) {
  return value instanceof globalThis.Int8Array;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUint8ClampedArray(value) {
  return value instanceof globalThis.Uint8ClampedArray;
}
function IsInt16Array(value) {
  return value instanceof globalThis.Int16Array;
}
function IsUint16Array(value) {
  return value instanceof globalThis.Uint16Array;
}
function IsInt32Array(value) {
  return value instanceof globalThis.Int32Array;
}
function IsUint32Array(value) {
  return value instanceof globalThis.Uint32Array;
}
function IsFloat32Array(value) {
  return value instanceof globalThis.Float32Array;
}
function IsFloat64Array(value) {
  return value instanceof globalThis.Float64Array;
}
function IsBigInt64Array(value) {
  return value instanceof globalThis.BigInt64Array;
}
function IsBigUint64Array(value) {
  return value instanceof globalThis.BigUint64Array;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}

// node_modules/typebox/build/system/memory/clone.mjs
function FromClassInstance(value) {
  return value;
}
function IsTypeObject(value) {
  return guard_exports.HasPropertyKey(value, "~kind") || guard_exports.HasPropertyKey(value, "~unsafe");
}
function FromTypeObject(value) {
  const result = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    const descriptor = descriptors[key];
    if (guard_exports.HasPropertyKey(descriptor, "value")) {
      Object.defineProperty(result, key, { ...descriptor, value: FromValue(descriptor.value) });
    }
  }
  return result;
}
function FromPlainObject(value) {
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    result[key] = FromValue(value[key]);
  }
  for (const key of guard_exports.Symbols(value)) {
    result[key] = FromValue(value[key]);
  }
  return result;
}
function FromObject(value) {
  return guard_exports.IsClassInstance(value) ? FromClassInstance(value) : IsTypeObject(value) ? FromTypeObject(value) : FromPlainObject(value);
}
function FromArray(value) {
  return value.map((element) => FromValue(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromRegExp(value) {
  return new RegExp(value.source, value.flags);
}
function FromMap(value) {
  return new Map(FromValue([...value.entries()]));
}
function FromSet(value) {
  return new Set(FromValue([...value.values()]));
}
function FromValue(value) {
  return globals_exports.IsTypeArray(value) ? FromTypedArray(value) : globals_exports.IsRegExp(value) ? FromRegExp(value) : globals_exports.IsMap(value) ? FromMap(value) : globals_exports.IsSet(value) ? FromSet(value) : guard_exports.IsArray(value) ? FromArray(value) : guard_exports.IsObject(value) ? FromObject(value) : value;
}
function Clone(value) {
  Metrics.clone += 1;
  return FromValue(value);
}

// node_modules/typebox/build/system/settings/settings.mjs
var settings_exports = {};
__export(settings_exports, {
  Get: () => Get,
  Reset: () => Reset,
  Set: () => Set2
});
var settings = {
  immutableTypes: false,
  maxErrors: 8,
  useAcceleration: true,
  exactOptionalPropertyTypes: false,
  enumerableKind: false,
  correctiveParse: false,
  unionPrioritySort: true
};
function Reset() {
  settings.immutableTypes = false;
  settings.maxErrors = 8;
  settings.useAcceleration = true;
  settings.exactOptionalPropertyTypes = false;
  settings.enumerableKind = false;
  settings.correctiveParse = false;
  settings.unionPrioritySort = true;
}
function Set2(options) {
  for (const key of guard_exports.Keys(options)) {
    const value = options[key];
    if (value !== void 0) {
      Object.defineProperty(settings, key, { value });
    }
  }
}
function Get() {
  return settings;
}

// node_modules/typebox/build/system/memory/create.mjs
function MergeHidden(left, right) {
  for (const key of Object.keys(right)) {
    Object.defineProperty(left, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: right[key]
    });
  }
  return left;
}
function Merge(left, right) {
  return { ...left, ...right };
}
function Create(hidden, enumerable, options = {}) {
  Metrics.create += 1;
  const settings2 = settings_exports.Get();
  const withOptions = Merge(enumerable, options);
  const withHidden = settings2.enumerableKind ? Merge(withOptions, hidden) : MergeHidden(withOptions, hidden);
  return settings2.immutableTypes ? Object.freeze(withHidden) : withHidden;
}

// node_modules/typebox/build/system/memory/discard.mjs
function Discard(value, propertyKeys) {
  Metrics.discard += 1;
  const result = {};
  const descriptors = Object.getOwnPropertyDescriptors(Clone(value));
  const keysToDiscard = new Set(propertyKeys);
  for (const key of Object.keys(descriptors)) {
    if (keysToDiscard.has(key))
      continue;
    Object.defineProperty(result, key, descriptors[key]);
  }
  return result;
}

// node_modules/typebox/build/system/memory/update.mjs
function Update(current, hidden, enumerable) {
  Metrics.update += 1;
  const settings2 = settings_exports.Get();
  const result = Clone(current);
  for (const key of Object.keys(hidden)) {
    Object.defineProperty(result, key, {
      configurable: true,
      writable: true,
      enumerable: settings2.enumerableKind,
      value: hidden[key]
    });
  }
  for (const key of Object.keys(enumerable)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: enumerable[key]
    });
  }
  return result;
}

// node_modules/typebox/build/type/types/schema.mjs
function IsKind(value, kind) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], kind);
}
function IsSchema(value) {
  return guard_exports.IsObject(value);
}

// node_modules/typebox/build/type/types/deferred.mjs
function Deferred(action, parameters, options) {
  return memory_exports.Create({ "~kind": "Deferred" }, { type: "deferred", action, parameters, options }, {});
}
function IsDeferred(value) {
  return IsKind(value, "Deferred");
}

// node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs
function AddReadonlyOperation(type) {
  return memory_exports.Update(type, { "~readonly": true }, {});
}
function AddReadonlyAction(type, options) {
  const result = memory_exports.Update(AddReadonlyOperation(type), {}, options);
  return result;
}
function AddReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_add.mjs
function AddOptionalOperation(type) {
  return memory_exports.Update(type, { "~optional": true }, {});
}
function AddOptionalAction(type, options) {
  const result = memory_exports.Update(AddOptionalOperation(type), {}, options);
  return result;
}
function AddOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/types/array.mjs
function _Array_(items, options) {
  return memory_exports.Create({ "~kind": "Array" }, { type: "array", items }, options);
}
function IsArray2(value) {
  return IsKind(value, "Array");
}
function ArrayOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items"]);
}

// node_modules/typebox/build/type/types/constructor.mjs
function Constructor(parameters, instanceType, options = {}) {
  return memory_exports.Create({ "~kind": "Constructor" }, { type: "constructor", parameters, instanceType }, options);
}
function IsConstructor2(value) {
  return IsKind(value, "Constructor");
}
function ConstructorOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "instanceType"]);
}

// node_modules/typebox/build/type/types/function.mjs
function _Function_(parameters, returnType, options = {}) {
  return memory_exports.Create({ ["~kind"]: "Function" }, { type: "function", parameters, returnType }, options);
}
function IsFunction2(value) {
  return IsKind(value, "Function");
}
function FunctionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "returnType"]);
}

// node_modules/typebox/build/type/types/ref.mjs
function Ref(ref, options) {
  return memory_exports.Create({ ["~kind"]: "Ref" }, { $ref: ref }, options);
}
function IsRef(value) {
  return IsKind(value, "Ref");
}

// node_modules/typebox/build/type/types/generic.mjs
function Generic(parameters, expression) {
  return memory_exports.Create({ "~kind": "Generic" }, { type: "generic", parameters, expression });
}
function IsGeneric(value) {
  return IsKind(value, "Generic");
}

// node_modules/typebox/build/type/types/any.mjs
function Any(options) {
  return memory_exports.Create({ ["~kind"]: "Any" }, {}, options);
}
function IsAny(value) {
  return IsKind(value, "Any");
}

// node_modules/typebox/build/type/types/never.mjs
var NeverPattern = "(?!)";
function Never(options) {
  return memory_exports.Create({ "~kind": "Never" }, { not: {} }, options);
}
function IsNever(value) {
  return IsKind(value, "Never");
}

// node_modules/typebox/build/type/action/_add_optional.mjs
function AddOptionalDeferred(type, options = {}) {
  return Deferred("AddOptional", [type], options);
}
function AddOptional(type, options = {}) {
  return AddOptionalAction(type, options);
}

// node_modules/typebox/build/type/types/_optional.mjs
function Optional(type) {
  return AddOptional(type);
}
function IsOptional(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~optional");
}

// node_modules/typebox/build/type/types/properties.mjs
function RequiredArray(properties) {
  return guard_exports.Keys(properties).filter((key) => !IsOptional(properties[key]));
}
function PropertyKeys(properties) {
  return guard_exports.Keys(properties);
}
function PropertyValues(properties) {
  return guard_exports.Values(properties);
}

// node_modules/typebox/build/type/types/object.mjs
function _Object_(properties, options = {}) {
  const requiredKeys = RequiredArray(properties);
  const required = requiredKeys.length > 0 ? { required: requiredKeys } : {};
  return memory_exports.Create({ "~kind": "Object" }, { type: "object", ...required, properties }, options);
}
function IsObject2(value) {
  return IsKind(value, "Object");
}
function ObjectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "properties", "required"]);
}

// node_modules/typebox/build/type/types/unknown.mjs
function Unknown(options) {
  return memory_exports.Create({ ["~kind"]: "Unknown" }, {}, options);
}
function IsUnknown(value) {
  return IsKind(value, "Unknown");
}

// node_modules/typebox/build/type/types/cyclic.mjs
function Cyclic($defs, $ref, options) {
  const defs = guard_exports.Keys($defs).reduce((result, key) => {
    return { ...result, [key]: memory_exports.Update($defs[key], {}, { $id: key }) };
  }, {});
  return memory_exports.Create({ ["~kind"]: "Cyclic" }, { $defs: defs, $ref }, options);
}
function IsCyclic(value) {
  return IsKind(value, "Cyclic");
}

// node_modules/typebox/build/type/types/unsafe.mjs
function Unsafe(schema) {
  return memory_exports.Update(schema, { ["~unsafe"]: null }, {});
}
function IsUnsafe(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "~unsafe") && guard_exports.IsNull(value["~unsafe"]);
}

// node_modules/typebox/build/system/arguments/arguments.mjs
var arguments_exports = {};
__export(arguments_exports, {
  Match: () => Match
});
function Match(args, match) {
  return match[args.length]?.(...args) ?? (() => {
    throw Error("Invalid Arguments");
  })();
}

// node_modules/typebox/build/type/types/infer.mjs
function Infer(...args) {
  const [name, extends_] = arguments_exports.Match(args, {
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ ["~kind"]: "Infer" }, { type: "infer", name, extends: extends_ }, {});
}
function IsInfer(value) {
  return IsKind(value, "Infer");
}

// node_modules/typebox/build/type/types/dependent.mjs
function Dependent(if_, then_, else_, options = {}) {
  return memory_exports.Create({ "~kind": "Dependent" }, { if: if_, then: then_, else: else_ }, options);
}
function IsDependent(value) {
  return IsKind(value, "Dependent");
}
function DependentOptions(type) {
  return memory_exports.Discard(type, ["~kind", "if", "then", "else"]);
}

// node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs
function IsTypeScriptEnumLike(value) {
  return guard_exports.IsObjectNotArray(value);
}
function TypeScriptEnumToEnumValues(type) {
  const keys = guard_exports.Keys(type).filter((key) => isNaN(key));
  return keys.reduce((result, key) => [...result, type[key]], []);
}

// node_modules/typebox/build/type/types/enum.mjs
function IsEnumValue(value) {
  return guard_exports.IsString(value) || guard_exports.IsNumber(value);
}
function Enum(value, options) {
  const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
  return memory_exports.Create({ "~kind": "Enum" }, { enum: values }, options);
}
function IsEnum(value) {
  return IsKind(value, "Enum");
}

// node_modules/typebox/build/type/types/intersect.mjs
function Intersect(types, options = {}) {
  return memory_exports.Create({ "~kind": "Intersect" }, { allOf: types }, options);
}
function IsIntersect(value) {
  return IsKind(value, "Intersect");
}
function IntersectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "allOf"]);
}

// node_modules/typebox/build/system/unreachable/unreachable.mjs
function Unreachable() {
  throw new Error("Unreachable");
}

// node_modules/typebox/build/system/hashing/hash.mjs
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
  ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
  ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
  ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
  ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
  ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
  ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
  ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
  ByteMarker2[ByteMarker2["String"] = 10] = "String";
  ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
  ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
  ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt(
  "18446744073709551616"
  /* 2 ^ 64 */
)];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
var encoder = new TextEncoder();

// node_modules/typebox/build/type/types/_codec.mjs
var EncodeBuilder = class {
  constructor(type, decode2) {
    this.type = type;
    this.decode = decode2;
  }
  Encode(callback) {
    const type = this.type;
    const decode2 = IsCodec(type) ? (value) => this.decode(type["~codec"].decode(value)) : this.decode;
    const encode = IsCodec(type) ? (value) => type["~codec"].encode(callback(value)) : callback;
    const codec = { decode: decode2, encode };
    return memory_exports.Update(this.type, { "~codec": codec }, {});
  }
};
var DecodeBuilder = class {
  constructor(type) {
    this.type = type;
  }
  Decode(callback) {
    return new EncodeBuilder(this.type, callback);
  }
};
function Codec(type) {
  return new DecodeBuilder(type);
}
function Decode(type, callback) {
  return Codec(type).Decode(callback).Encode(() => {
    throw Error("Encode not implemented");
  });
}
function Encode(type, callback) {
  return Codec(type).Decode(() => {
    throw Error("Decode not implemented");
  }).Encode(callback);
}
function IsCodec(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~codec") && guard_exports.IsObject(value["~codec"]) && guard_exports.HasPropertyKey(value["~codec"], "encode") && guard_exports.HasPropertyKey(value["~codec"], "decode");
}

// node_modules/typebox/build/type/types/_immutable.mjs
function Immutable(type) {
  return AddImmutable(type);
}
function IsImmutable(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~immutable");
}

// node_modules/typebox/build/type/action/_add_readonly.mjs
function AddReadonlyDeferred(type, options = {}) {
  return Deferred("AddReadonly", [type], options);
}
function AddReadonly(type, options = {}) {
  return AddReadonlyAction(type, options);
}

// node_modules/typebox/build/type/types/_readonly.mjs
function Readonly(type) {
  return AddReadonly(type);
}
function IsReadonly(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~readonly");
}

// node_modules/typebox/build/type/types/_refine.mjs
function RefineAdd(type, refinement) {
  const refinements = IsRefine(type) ? [...type["~refine"], refinement] : [refinement];
  return memory_exports.Update(type, { "~refine": refinements }, {});
}
function Refine(...args) {
  const [type, check, error] = arguments_exports.Match(args, {
    3: (type2, check2, error2) => [type2, check2, error2],
    2: (type2, check2) => [type2, check2, () => "Refine Error"]
  });
  return RefineAdd(type, { check, error });
}
function IsRefinement(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "check") && guard_exports.HasPropertyKey(value, "error") && guard_exports.IsFunction(value.check) && guard_exports.IsFunction(value.error);
}
function IsRefine(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => IsRefinement(value2));
}

// node_modules/typebox/build/type/types/bigint.mjs
var BigIntPattern = "-?(?:0|[1-9][0-9]*)n";
function BigInt2(options) {
  return memory_exports.Create({ "~kind": "BigInt" }, { type: "bigint" }, options);
}
function IsBigInt2(value) {
  return IsKind(value, "BigInt");
}

// node_modules/typebox/build/type/types/boolean.mjs
function Boolean2(options) {
  return memory_exports.Create({ "~kind": "Boolean" }, { type: "boolean" }, options);
}
function IsBoolean3(value) {
  return IsKind(value, "Boolean");
}

// node_modules/typebox/build/type/types/identifier.mjs
function Identifier(name) {
  return memory_exports.Create({ "~kind": "Identifier" }, { name });
}
function IsIdentifier(value) {
  return IsKind(value, "Identifier");
}

// node_modules/typebox/build/type/types/integer.mjs
var IntegerPattern = "-?(?:0|[1-9][0-9]*)";
function Integer(options) {
  return memory_exports.Create({ "~kind": "Integer" }, { type: "integer" }, options);
}
function IsInteger2(value) {
  return IsKind(value, "Integer");
}

// node_modules/typebox/build/type/types/literal.mjs
var InvalidLiteralValue = class extends Error {
  constructor(value) {
    super(`Invalid Literal value`);
    Object.defineProperty(this, "cause", {
      value: { value },
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
};
function LiteralTypeName(value) {
  return guard_exports.IsBigInt(value) ? "bigint" : guard_exports.IsBoolean(value) ? "boolean" : guard_exports.IsNumber(value) ? "number" : guard_exports.IsString(value) ? "string" : (() => {
    throw new InvalidLiteralValue(value);
  })();
}
function Literal(value, options) {
  return memory_exports.Create({ "~kind": "Literal" }, { type: LiteralTypeName(value), const: value }, options);
}
function IsLiteralValue(value) {
  return guard_exports.IsBigInt(value) || guard_exports.IsBoolean(value) || guard_exports.IsNumber(value) || guard_exports.IsString(value);
}
function IsLiteralNumber(value) {
  return IsLiteral(value) && guard_exports.IsNumber(value.const);
}
function IsLiteralString(value) {
  return IsLiteral(value) && guard_exports.IsString(value.const);
}
function IsLiteral(value) {
  return IsKind(value, "Literal");
}

// node_modules/typebox/build/type/types/null.mjs
function Null(options) {
  return memory_exports.Create({ "~kind": "Null" }, { type: "null" }, options);
}
function IsNull2(value) {
  return IsKind(value, "Null");
}

// node_modules/typebox/build/type/types/number.mjs
var NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
function Number2(options) {
  return memory_exports.Create({ "~kind": "Number" }, { type: "number" }, options);
}
function IsNumber3(value) {
  return IsKind(value, "Number");
}

// node_modules/typebox/build/type/types/symbol.mjs
function Symbol2(options) {
  return memory_exports.Create({ "~kind": "Symbol" }, { type: "symbol" }, options);
}
function IsSymbol2(value) {
  return IsKind(value, "Symbol");
}

// node_modules/typebox/build/type/types/parameter.mjs
function Parameter(...args) {
  const [name, extends_, equals] = arguments_exports.Match(args, {
    3: (name2, extends_2, equals2) => [name2, extends_2, equals2],
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ "~kind": "Parameter" }, { name, extends: extends_, equals }, {});
}
function IsParameter(value) {
  return IsKind(value, "Parameter");
}

// node_modules/typebox/build/type/types/string.mjs
var StringPattern = ".*";
function String2(options) {
  return memory_exports.Create({ "~kind": "String" }, { type: "string" }, options);
}
function IsString3(value) {
  return IsKind(value, "String");
}

// node_modules/typebox/build/type/types/union.mjs
function Union(anyOf, options = {}) {
  return memory_exports.Create({ "~kind": "Union" }, { anyOf }, options);
}
function IsUnion(value) {
  return IsKind(value, "Union");
}
function UnionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "anyOf"]);
}

// node_modules/typebox/build/type/engine/patterns/pattern.mjs
function ParsePatternIntoTypes(pattern) {
  const parsed = Pattern(pattern);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : [];
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/is_finite.mjs
function FromLiteral(_value) {
  return true;
}
function FromTypesReduce(types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType(left) ? FromTypesReduce(right) : false, () => true);
}
function FromTypes(types) {
  const result = guard_exports.IsEqual(types.length, 0) ? false : FromTypesReduce(types);
  return result;
}
function FromType(type) {
  return IsUnion(type) ? FromTypes(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : false;
}
function IsTemplateLiteralFinite(types) {
  const result = FromTypes(types);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/create.mjs
function TemplateLiteralCreate(pattern) {
  return memory_exports.Create({ ["~kind"]: "TemplateLiteral" }, { type: "string", pattern }, {});
}

// node_modules/typebox/build/type/engine/template_literal/decode.mjs
function FromLiteralPush(variants, value, result = []) {
  return guard_exports.ShiftLeft(variants, (left, right) => FromLiteralPush(right, value, [...result, `${left}${value}`]), () => result);
}
function FromLiteral2(variants, value) {
  return guard_exports.IsEqual(variants.length, 0) ? [`${value}`] : FromLiteralPush(variants, value);
}
function FromUnion(variants, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => FromUnion(variants, right, [...result, ...FromType2(variants, left)]), () => result);
}
function FromType2(variants, type) {
  const result = IsUnion(type) ? FromUnion(variants, type.anyOf) : IsLiteral(type) ? FromLiteral2(variants, type.const) : Unreachable();
  return result;
}
function DecodeFromSpan(variants, types) {
  return guard_exports.ShiftLeft(types, (left, right) => DecodeFromSpan(FromType2(variants, left), right), () => variants);
}
function VariantsToLiterals(variants) {
  return variants.map((variant) => Literal(variant));
}
function DecodeTypesAsUnion(types) {
  const variants = DecodeFromSpan([], types);
  const literals = VariantsToLiterals(variants);
  const result = Union(literals);
  return result;
}
function DecodeTypes(types) {
  return guard_exports.IsEqual(types.length, 0) ? Unreachable() : (
    // Literal('') :
    guard_exports.IsEqual(types.length, 1) && IsLiteral(types[0]) ? types[0] : DecodeTypesAsUnion(types)
  );
}
function TemplateLiteralDecodeUnsafe(pattern) {
  const types = ParsePatternIntoTypes(pattern);
  const result = guard_exports.IsEqual(types.length, 0) ? String2() : IsTemplateLiteralFinite(types) ? DecodeTypes(types) : TemplateLiteralCreate(pattern);
  return result;
}
function TemplateLiteralDecode(pattern) {
  const decoded = TemplateLiteralDecodeUnsafe(pattern);
  const result = IsTemplateLiteral(decoded) ? String2() : decoded;
  return result;
}

// node_modules/typebox/build/type/engine/record/record_create.mjs
function CreateRecord(key, value) {
  const type = "object";
  const patternProperties = { [key]: value };
  return memory_exports.Create({ ["~kind"]: "Record" }, { type, patternProperties });
}

// node_modules/typebox/build/type/engine/record/from_key_any.mjs
function FromAnyKey(value) {
  return CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_boolean.mjs
function FromBooleanKey(value) {
  return _Object_({ true: value, false: value });
}

// node_modules/typebox/build/type/types/tuple.mjs
function Tuple(types, options = {}) {
  const [items, minItems, additionalItems] = [types, types.length, false];
  return memory_exports.Create({ ["~kind"]: "Tuple" }, { type: "array", additionalItems, items, minItems }, options);
}
function IsTuple(value) {
  return IsKind(value, "Tuple");
}
function TupleOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items", "minItems", "additionalItems"]);
}

// node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs
function RemoveReadonlyOperation(type) {
  return memory_exports.Discard(type, ["~readonly"]);
}
function RemoveReadonlyAction(type, options) {
  const result = memory_exports.Update(RemoveReadonlyOperation(type), {}, options);
  return result;
}
function RemoveReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_readonly.mjs
function RemoveReadonlyDeferred(type, options = {}) {
  return Deferred("RemoveReadonly", [type], options);
}
function RemoveReadonly(type, options = {}) {
  return RemoveReadonlyAction(type, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs
function RemoveOptionalOperation(type) {
  return memory_exports.Discard(type, ["~optional"]);
}
function RemoveOptionalAction(type, options) {
  const result = memory_exports.Update(RemoveOptionalOperation(type), {}, options);
  return result;
}
function RemoveOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_optional.mjs
function RemoveOptionalDeferred(type, options = {}) {
  return Deferred("RemoveOptional", [type], options);
}
function RemoveOptional(type, options = {}) {
  return RemoveOptionalAction(type, options);
}

// node_modules/typebox/build/type/engine/tuple/to_object.mjs
function TupleElementsToProperties(types) {
  const result = types.reduceRight((result2, right, index) => {
    return { [index]: right, ...result2 };
  }, {});
  return result;
}
function TupleToObject(type) {
  const properties = TupleElementsToProperties(type.items);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/composite.mjs
function IsReadonlyProperty(left, right) {
  return IsReadonly(left) ? IsReadonly(right) ? true : false : false;
}
function IsOptionalProperty(left, right) {
  return IsOptional(left) ? IsOptional(right) ? true : false : false;
}
function CompositeProperty(left, right) {
  const isReadonly = IsReadonlyProperty(left, right);
  const isOptional = IsOptionalProperty(left, right);
  const evaluated = EvaluateIntersect([left, right]);
  const property = RemoveReadonly(RemoveOptional(evaluated));
  return isReadonly && isOptional ? AddReadonly(AddOptional(property)) : isReadonly && !isOptional ? AddReadonly(property) : !isReadonly && isOptional ? AddOptional(property) : property;
}
function CompositePropertyKey(left, right, key) {
  return key in left ? key in right ? CompositeProperty(left[key], right[key]) : left[key] : key in right ? right[key] : Never();
}
function CompositeProperties(left, right) {
  const keys = /* @__PURE__ */ new Set([...guard_exports.Keys(right), ...guard_exports.Keys(left)]);
  return [...keys].reduce((result, key) => {
    return { ...result, [key]: CompositePropertyKey(left, right, key) };
  }, {});
}
function GetProperties(type) {
  const result = IsObject2(type) ? type.properties : IsTuple(type) ? TupleElementsToProperties(type.items) : Unreachable();
  return result;
}
function Composite(left, right) {
  const leftProperties = GetProperties(left);
  const rightProperties = GetProperties(right);
  const properties = CompositeProperties(leftProperties, rightProperties);
  return _Object_(properties);
}

// node_modules/typebox/build/type/engine/evaluate/narrow.mjs
function Narrow(left, right) {
  const result = Compare(left, right);
  return guard_exports.IsEqual(result, ResultLeftInside) ? left : guard_exports.IsEqual(result, ResultRightInside) ? right : guard_exports.IsEqual(result, ResultEqual) ? right : Never();
}

// node_modules/typebox/build/type/engine/evaluate/distribute.mjs
function IsObjectLike(type) {
  return IsObject2(type) || IsTuple(type);
}
function IsUnionOperand(left, right) {
  const isUnionLeft = IsUnion(left);
  const isUnionRight = IsUnion(right);
  const result = isUnionLeft || isUnionRight;
  return result;
}
function DistributeOperation(left, right) {
  const evaluatedLeft = EvaluateType(left);
  const evaluatedRight = EvaluateType(right);
  const isUnionOperand = IsUnionOperand(evaluatedLeft, evaluatedRight);
  const isObjectLeft = IsObjectLike(evaluatedLeft);
  const IsObjectRight = IsObjectLike(evaluatedRight);
  const result = isUnionOperand ? EvaluateIntersect([evaluatedLeft, evaluatedRight]) : isObjectLeft && IsObjectRight ? Composite(evaluatedLeft, evaluatedRight) : isObjectLeft && !IsObjectRight ? evaluatedLeft : !isObjectLeft && IsObjectRight ? evaluatedRight : Narrow(evaluatedLeft, evaluatedRight);
  return result;
}
function DistributeType(type, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeType(type, right, [...result, DistributeOperation(type, left)]), () => guard_exports.IsEqual(result.length, 0) ? [type] : result);
}
function DistributeUnion(types, distribution, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeUnion(right, distribution, [...result, ...Distribute([left], distribution)]), () => result);
}
function Distribute(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => IsUnion(left) ? Distribute(right, DistributeUnion(left.anyOf, result)) : Distribute(right, DistributeType(left, result)), () => result);
}

// node_modules/typebox/build/type/engine/exclude/operation.mjs
function ExcludeType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [] : [left];
  return result;
}
function ExcludeUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExcludeType(head, right)];
  }, []);
}
function ExcludeOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExcludeUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/evaluate.mjs
function EvaluateDependent(if_, then_, else_) {
  const intersect = Intersect([if_, then_]);
  const excluded = ExcludeOperation(else_, if_);
  const result = EvaluateUnion([intersect, excluded]);
  return result;
}
function EvaluateEnum(values) {
  const result = values.map((value) => Literal(value));
  return EvaluateUnion(result);
}
function EvaluateIntersect(types) {
  const distribution = Distribute(types);
  const broadend = Broaden(distribution);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateTemplateLiteral(pattern) {
  const evaluated = TemplateLiteralDecode(pattern);
  const result = EvaluateType(evaluated);
  return result;
}
function EvaluateUnion(types) {
  const broadend = Broaden(types);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateType(type) {
  return IsDependent(type) ? EvaluateDependent(type.if, type.then, type.else) : IsEnum(type) ? EvaluateEnum(type.enum) : IsIntersect(type) ? EvaluateIntersect(type.allOf) : IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsUnion(type) ? EvaluateUnion(type.anyOf) : type;
}
function EvaluateUnionFast(types) {
  const result = guard_exports.IsEqual(types.length, 1) ? types[0] : guard_exports.IsEqual(types.length, 0) ? Never() : Union(types);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_enum.mjs
function FromEnumKey(values, value) {
  const unionKey = EvaluateEnum(values);
  const result = FromKey(unionKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_integer.mjs
function FromIntegerKey(_key, value) {
  const result = CreateRecord(IntegerKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_intersect.mjs
function FromIntersectKey(types, value) {
  const evaluatedKey = EvaluateIntersect(types);
  const result = FromKey(evaluatedKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_literal.mjs
function FromLiteralKey(key, value) {
  return guard_exports.IsString(key) || guard_exports.IsNumber(key) ? _Object_({ [key]: value }) : guard_exports.IsEqual(key, false) ? _Object_({ false: value }) : guard_exports.IsEqual(key, true) ? _Object_({ true: value }) : _Object_({});
}

// node_modules/typebox/build/type/engine/record/from_key_number.mjs
function FromNumberKey(_key, value) {
  const result = CreateRecord(NumberKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_string.mjs
function FromStringKey(key, value) {
  return guard_exports.HasPropertyKey(key, "pattern") && (guard_exports.IsString(key.pattern) || key.pattern instanceof RegExp) ? CreateRecord(key.pattern.toString(), value) : CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs
function FromTemplateKey(pattern, value) {
  const types = ParsePatternIntoTypes(pattern);
  const finite = IsTemplateLiteralFinite(types);
  const result = finite ? FromKey(EvaluateTemplateLiteral(pattern), value) : CreateRecord(pattern, value);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/flatten.mjs
function FlattenType(type) {
  const result = IsUnion(type) ? Flatten(type.anyOf) : [type];
  return result;
}
function Flatten(types) {
  return types.reduce((result, type) => {
    return [...result, ...FlattenType(type)];
  }, []);
}

// node_modules/typebox/build/type/engine/record/from_key_union.mjs
function StringOrNumberCheck(types) {
  return types.some((type) => IsString3(type) || IsNumber3(type) || IsInteger2(type));
}
function TryBuildRecord(types, value) {
  return guard_exports.IsEqual(StringOrNumberCheck(types), true) ? CreateRecord(StringKey, value) : void 0;
}
function CreateProperties(types, value) {
  return types.reduce((result, left) => {
    return IsLiteral(left) && (guard_exports.IsString(left.const) || guard_exports.IsNumber(left.const)) ? { ...result, [left.const]: value } : result;
  }, {});
}
function CreateObject(types, value) {
  const properties = CreateProperties(types, value);
  const result = _Object_(properties);
  return result;
}
function FromUnionKey(types, value) {
  const flattened = Flatten(types);
  const record = TryBuildRecord(flattened, value);
  return IsSchema(record) ? record : CreateObject(flattened, value);
}

// node_modules/typebox/build/type/engine/record/from_key.mjs
function FromKey(key, value) {
  const result = IsAny(key) ? FromAnyKey(value) : IsBoolean3(key) ? FromBooleanKey(value) : IsEnum(key) ? FromEnumKey(key.enum, value) : IsInteger2(key) ? FromIntegerKey(key, value) : IsIntersect(key) ? FromIntersectKey(key.allOf, value) : IsLiteral(key) ? FromLiteralKey(key.const, value) : IsNumber3(key) ? FromNumberKey(key, value) : IsUnion(key) ? FromUnionKey(key.anyOf, value) : IsString3(key) ? FromStringKey(key, value) : IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) : _Object_({});
  return result;
}

// node_modules/typebox/build/type/engine/record/instantiate.mjs
function RecordAction(key, value, options) {
  const result = CanInstantiate([key]) ? memory_exports.Update(FromKey(key, value), {}, options) : RecordDeferred(key, value, options);
  return result;
}
function RecordInstantiate(context, state, key, value, options) {
  const instantiatedKey = InstantiateType(context, state, key);
  const instantiatedValue = InstantiateType(context, state, value);
  return RecordAction(instantiatedKey, instantiatedValue, options);
}

// node_modules/typebox/build/type/types/record.mjs
var IntegerKey = `^${IntegerPattern}$`;
var NumberKey = `^${NumberPattern}$`;
var StringKey = `^${StringPattern}$`;
function RecordDeferred(key, value, options = {}) {
  return Deferred("Record", [key, value], options);
}
function Record(key, value, options = {}) {
  return RecordAction(key, value, options);
}
function RecordFromPattern(pattern, value) {
  return CreateRecord(pattern, value);
}
function RecordPatternToType(pattern) {
  const result = guard_exports.IsEqual(pattern, StringKey) ? String2() : guard_exports.IsEqual(pattern, IntegerKey) ? Integer() : guard_exports.IsEqual(pattern, NumberKey) ? Number2() : TemplateLiteralDecodeUnsafe(pattern);
  return result;
}
function RecordPattern(type) {
  return guard_exports.Keys(type.patternProperties)[0];
}
function RecordKey(type) {
  const pattern = RecordPattern(type);
  const result = RecordPatternToType(pattern);
  return result;
}
function RecordValue(type) {
  return type.patternProperties[RecordPattern(type)];
}
function IsRecord(value) {
  return IsKind(value, "Record");
}

// node_modules/typebox/build/type/types/rest.mjs
function Rest(type) {
  return memory_exports.Create({ "~kind": "Rest" }, { type: "rest", items: type }, {});
}
function IsRest(value) {
  return IsKind(value, "Rest");
}

// node_modules/typebox/build/type/types/this.mjs
function This(options) {
  return memory_exports.Create({ ["~kind"]: "This" }, { $ref: "#" }, options);
}
function IsThis(value) {
  return IsKind(value, "This");
}

// node_modules/typebox/build/type/types/undefined.mjs
function Undefined(options) {
  return memory_exports.Create({ "~kind": "Undefined" }, { type: "undefined" }, options);
}
function IsUndefined2(value) {
  return IsKind(value, "Undefined");
}

// node_modules/typebox/build/type/types/void.mjs
function Void(options) {
  return memory_exports.Create({ "~kind": "Void" }, { type: "void" }, options);
}
function IsVoid(value) {
  return IsKind(value, "Void");
}

// node_modules/typebox/build/type/script/mapping.mjs
function IntrinsicOrCall(ref, parameters) {
  return guard_exports.IsEqual(ref, "Array") ? _Array_(parameters[0]) : guard_exports.IsEqual(ref, "Capitalize") ? CapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ConstructorParameters") ? ConstructorParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Evaluate") ? EvaluateDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Exclude") ? ExcludeDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Extract") ? ExtractDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Index") ? IndexDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "InstanceType") ? InstanceTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Lowercase") ? LowercaseDeferred(parameters[0]) : guard_exports.IsEqual(ref, "NonNullable") ? NonNullableDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Omit") ? OmitDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Parameters") ? ParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Partial") ? PartialDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Pick") ? PickDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Readonly") ? ReadonlyObjectDeferred(parameters[0]) : guard_exports.IsEqual(ref, "KeyOf") ? KeyOfDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Record") ? RecordDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Required") ? RequiredDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ReturnType") ? ReturnTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uncapitalize") ? UncapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uppercase") ? UppercaseDeferred(parameters[0]) : CallConstruct(Ref(ref), parameters);
}
function Unreachable2() {
  throw Error("Unreachable");
}
var DelimitedDecode = (input, result = []) => {
  return input.reduce((result2, left) => {
    return guard_exports.IsArray(left) && guard_exports.IsEqual(left.length, 2) ? [...result2, left[0]] : [...result2, left];
  }, []);
};
var Delimited = (input) => {
  const [left, right] = input;
  return DelimitedDecode([...left, ...right]);
};
function GenericParameterExtendsEqualsMapping(input) {
  return Parameter(input[0], input[2], input[4]);
}
function GenericParameterExtendsMapping(input) {
  return Parameter(input[0], input[2], input[2]);
}
function GenericParameterEqualsMapping(input) {
  return Parameter(input[0], Unknown(), input[2]);
}
function GenericParameterIdentifierMapping(input) {
  return Parameter(input, Unknown(), Unknown());
}
function GenericParameterMapping(input) {
  return input;
}
function GenericParameterListMapping(input) {
  return Delimited(input);
}
function GenericParametersMapping(input) {
  return input[1];
}
function GenericCallArgumentListMapping(input) {
  return Delimited(input);
}
function GenericCallArgumentsMapping(input) {
  return input[1];
}
function GenericCallMapping(input) {
  return IntrinsicOrCall(input[0], input[1]);
}
function OptionalSemiColonMapping(input) {
  return null;
}
function KeywordStringMapping(input) {
  return String2();
}
function KeywordNumberMapping(input) {
  return Number2();
}
function KeywordBooleanMapping(input) {
  return Boolean2();
}
function KeywordUndefinedMapping(input) {
  return Undefined();
}
function KeywordNullMapping(input) {
  return Null();
}
function KeywordIntegerMapping(input) {
  return Integer();
}
function KeywordBigIntMapping(input) {
  return BigInt2();
}
function KeywordUnknownMapping(input) {
  return Unknown();
}
function KeywordAnyMapping(input) {
  return Any();
}
function KeywordObjectMapping(input) {
  return _Object_({});
}
function KeywordNeverMapping(input) {
  return Never();
}
function KeywordSymbolMapping(input) {
  return Symbol2();
}
function KeywordVoidMapping(input) {
  return Void();
}
function KeywordThisMapping(input) {
  return This();
}
function LiteralBigIntMapping(input) {
  return Literal(BigInt(input));
}
function LiteralBooleanMapping(input) {
  return Literal(guard_exports.IsEqual(input, "true"));
}
function LiteralNumberMapping(input) {
  return Literal(parseFloat(input));
}
function LiteralStringMapping(input) {
  return Literal(input);
}
function TemplateInterpolateMapping(input) {
  return input[1];
}
function TemplateSpanMapping(input) {
  return Literal(input);
}
function TemplateBodyMapping(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], input[1], ...input[2]] : [input[0]];
}
function TemplateLiteralTypesMapping(input) {
  return input[1];
}
function TemplateLiteralMapping(input) {
  return TemplateLiteralDeferred(input);
}
function DependentMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? Dependent(input[1], input[3], input[5]) : Dependent(input[1], input[3], Unknown());
}
function KeyOfMapping(input) {
  return input.length > 0;
}
function IndexArrayMapping(input) {
  return input.reduce((result, current) => {
    return guard_exports.IsEqual(current.length, 3) ? [...result, [current[1]]] : [...result, []];
  }, []);
}
function ExtendsMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? [input[1], input[3], input[5]] : [];
}
function BaseMapping(input) {
  return guard_exports.IsArray(input) && guard_exports.IsEqual(input.length, 3) ? input[1] : input;
}
function WithMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function FactorIndexArray(Type2, indexArray) {
  return indexArray.reduce((result, left) => {
    const _left = left;
    return guard_exports.IsEqual(_left.length, 1) ? IndexDeferred(result, _left[0]) : guard_exports.IsEqual(_left.length, 0) ? _Array_(result) : Unreachable2();
  }, Type2);
}
function FactorExtends(type, extend) {
  return guard_exports.IsEqual(extend.length, 3) ? ConditionalDeferred(type, extend[0], extend[1], extend[2]) : type;
}
function FactorWith(type, withClause) {
  return guard_exports.IsArray(withClause) && guard_exports.IsEqual(withClause.length, 0) ? type : WithDeferred(type, withClause);
}
function FactorMapping(input) {
  const [keyOf2, type, indexArray, extend, withClause] = input;
  return FactorWith(keyOf2 ? FactorExtends(KeyOfDeferred(FactorIndexArray(type, indexArray)), extend) : FactorExtends(FactorIndexArray(type, indexArray), extend), withClause);
}
function ExprBinaryMapping(left, rest) {
  return guard_exports.IsEqual(rest.length, 3) ? (() => {
    const [operator, right, next] = rest;
    const Schema = ExprBinaryMapping(right, next);
    if (guard_exports.IsEqual(operator, "&")) {
      return IsIntersect(Schema) ? Intersect([left, ...Schema.allOf]) : Intersect([left, Schema]);
    }
    if (guard_exports.IsEqual(operator, "|")) {
      return IsUnion(Schema) ? Union([left, ...Schema.anyOf]) : Union([left, Schema]);
    }
    Unreachable2();
  })() : left;
}
function ExprTermTailMapping(input) {
  return input;
}
function ExprTermMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprTailMapping(input) {
  return input;
}
function ExprMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprReadonlyMapping(input) {
  return AddImmutableDeferred(input[1]);
}
function ExprPipeMapping(input) {
  return input[1];
}
function GenericTypeMapping(input) {
  return Generic(input[0], input[2]);
}
function InferTypeMapping(input) {
  return guard_exports.IsEqual(input.length, 4) ? Infer(input[1], input[3]) : guard_exports.IsEqual(input.length, 2) ? Infer(input[1], Unknown()) : Unreachable2();
}
function TypeMapping(input) {
  return input;
}
function PropertyKeyNumberMapping(input) {
  return `${input}`;
}
function PropertyKeyIdentMapping(input) {
  return input;
}
function PropertyKeyQuotedMapping(input) {
  return input;
}
function PropertyKeyIndexMapping(input) {
  return IsInteger2(input[3]) ? IntegerKey : IsNumber3(input[3]) ? NumberKey : IsSymbol2(input[3]) ? StringKey : IsString3(input[3]) ? StringKey : Unreachable2();
}
function PropertyKeyMapping(input) {
  return input;
}
function ReadonlyMapping(input) {
  return input.length > 0;
}
function OptionalMapping(input) {
  return input.length > 0;
}
function PropertyMapping(input) {
  const [isReadonly, key, isOptional, _colon, type] = input;
  return {
    [key]: isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type
  };
}
function PropertyDelimiterMapping(input) {
  return input;
}
function PropertyListMapping(input) {
  return Delimited(input);
}
function PropertiesReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    const isPatternProperties = guard_exports.HasPropertyKey(left, IntegerKey) || guard_exports.HasPropertyKey(left, NumberKey) || guard_exports.HasPropertyKey(left, StringKey);
    return isPatternProperties ? [result[0], memory_exports.Assign(result[1], left)] : [memory_exports.Assign(result[0], left), result[1]];
  }, [{}, {}]);
}
function PropertiesMapping(input) {
  return PropertiesReduce(input[1]);
}
function _Object_Mapping(input) {
  const [properties, patternProperties] = input;
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return _Object_(properties, options);
}
function ElementNamedMapping(input) {
  return guard_exports.IsEqual(input.length, 5) ? AddReadonlyDeferred(AddOptionalDeferred(input[4])) : guard_exports.IsEqual(input.length, 3) ? input[2] : guard_exports.IsEqual(input.length, 4) ? guard_exports.IsEqual(input[2], "readonly") ? AddReadonlyDeferred(input[3]) : AddOptionalDeferred(input[3]) : Unreachable2();
}
function ElementReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[1]));
}
function ElementReadonlyMapping(input) {
  return AddReadonlyDeferred(input[1]);
}
function ElementOptionalMapping(input) {
  return AddOptionalDeferred(input[0]);
}
function ElementBaseMapping(input) {
  return input;
}
function ElementMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ElementListMapping(input) {
  return Delimited(input);
}
function _Tuple_Mapping(input) {
  return Tuple(input[1]);
}
function ParameterReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[4]));
}
function ParameterReadonlyMapping(input) {
  return AddReadonlyDeferred(input[3]);
}
function ParameterOptionalMapping(input) {
  return AddOptionalDeferred(input[3]);
}
function ParameterTypeMapping(input) {
  return input[2];
}
function ParameterBaseMapping(input) {
  return input;
}
function ParameterMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ParameterListMapping(input) {
  return Delimited(input);
}
function _Function_Mapping(input) {
  return _Function_(input[1], input[4]);
}
function _Constructor_Mapping(input) {
  return Constructor(input[2], input[5]);
}
function ApplyReadonly(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveReadonlyDeferred(type) : guard_exports.IsEqual(state, "add") ? AddReadonlyDeferred(type) : type;
}
function MappedReadonlyMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function ApplyOptional(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveOptionalDeferred(type) : guard_exports.IsEqual(state, "add") ? AddOptionalDeferred(type) : type;
}
function MappedOptionalMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function MappedAsMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? [input[1]] : [];
}
function _Mapped_Mapping(input) {
  return guard_exports.IsArray(input[6]) && guard_exports.IsEqual(input[6].length, 1) ? MappedDeferred(Identifier(input[3]), input[5], input[6][0], ApplyReadonly(input[1], ApplyOptional(input[8], input[10]))) : MappedDeferred(Identifier(input[3]), input[5], Ref(input[3]), ApplyReadonly(input[1], ApplyOptional(input[8], input[10])));
}
function ReferenceMapping(input) {
  return Ref(input);
}
function WithBigIntMapping(input) {
  return BigInt(input);
}
function WithNumberMapping(input) {
  return parseFloat(input);
}
function WithBooleanMapping(input) {
  return guard_exports.IsEqual(input, "true");
}
function WithStringMapping(input) {
  return input;
}
function WithNullMapping(input) {
  return null;
}
function WithUndefinedMapping(input) {
  return void 0;
}
function WithPropertyMapping(input) {
  return { [input[0]]: input[2] };
}
function WithPropertyListMapping(input) {
  return Delimited(input);
}
function WithObjectMappingReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    return memory_exports.Assign(result, left);
  }, {});
}
function WithObjectMapping(input) {
  return WithObjectMappingReduce(input[1]);
}
function WithElementListMapping(input) {
  return Delimited(input);
}
function WithArrayMapping(input) {
  return input[1];
}
function WithValueMapping(input) {
  return input;
}
function PatternBigIntMapping(input) {
  return BigInt2();
}
function PatternStringMapping(input) {
  return String2();
}
function PatternNumberMapping(input) {
  return Number2();
}
function PatternIntegerMapping(input) {
  return Integer();
}
function PatternNeverMapping(input) {
  return Never();
}
function PatternTextMapping(input) {
  return Literal(input);
}
function PatternBaseMapping(input) {
  return input;
}
function PatternGroupMapping(input) {
  return Union(input[1]);
}
function PatternUnionMapping(input) {
  return input.length === 3 ? [...input[0], ...input[2]] : input.length === 1 ? [...input[0]] : [];
}
function PatternTermMapping(input) {
  return [input[0], ...input[1]];
}
function PatternBodyMapping(input) {
  return input;
}
function PatternMapping(input) {
  return input[1];
}
function InterfaceDeclarationHeritageListMapping(input) {
  return Delimited(input);
}
function InterfaceDeclarationHeritageMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function InterfaceDeclarationGenericMapping(input) {
  const parameters = input[2];
  const heritage = input[3];
  const [properties, patternProperties] = input[4];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: Generic(parameters, InterfaceDeferred(heritage, properties, options)) };
}
function InterfaceDeclarationMapping(input) {
  const heritage = input[2];
  const [properties, patternProperties] = input[3];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: InterfaceDeferred(heritage, properties, options) };
}
function TypeAliasDeclarationGenericMapping(input) {
  return { [input[1]]: Generic(input[2], input[4]) };
}
function TypeAliasDeclarationMapping(input) {
  return { [input[1]]: input[3] };
}
function ExportKeywordMapping(input) {
  return null;
}
function ModuleDeclarationDelimiterMapping(input) {
  return input;
}
function ModuleDeclarationListMapping(input) {
  return PropertiesReduce(Delimited(input));
}
function ModuleDeclarationMapping(input) {
  return input[1];
}
function ModuleMapping(input) {
  const moduleDeclaration = input[0];
  const moduleDeclarationList = input[1];
  return ModuleDeferred(memory_exports.Assign(moduleDeclaration, moduleDeclarationList[0]));
}
function ScriptMapping(input) {
  return input;
}

// node_modules/typebox/build/type/script/token/internal/match.mjs
function IsMatch(value) {
  return IsEqual(value.length, 2);
}
function Match2(input, ok2, fail2) {
  return IsMatch(input) ? ok2(input[0], input[1]) : fail2();
}

// node_modules/typebox/build/type/script/token/internal/take.mjs
function TakeVariant(variant, input) {
  return IsEqual(input.indexOf(variant), 0) ? [variant, input.slice(variant.length)] : [];
}
function Take(variants, input) {
  for (let i = 0; i < variants.length; i++) {
    const result = TakeVariant(variants[i], input);
    if (IsMatch(result))
      return result;
  }
  return [];
}

// node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha = [
  ...Range(97, 122),
  // Lowercase
  ...Range(65, 90)
  // Uppercase
];
var Zero = "0";
var NonZero = Range(49, 57);
var Digit = [Zero, ...NonZero];
var WhiteSpace = " ";
var NewLine = "\n";
var UnderScore = "_";
var Dot = ".";
var DollarSign = "$";
var Hyphen = "-";

// node_modules/typebox/build/type/script/token/internal/trim.mjs
var LineComment = "//";
var OpenComment = "/*";
var CloseComment = "*/";
function DiscardMultilineComment(input) {
  const index = input.indexOf(CloseComment);
  const result = IsEqual(index, -1) ? "" : input.slice(index + 2);
  return result;
}
function DiscardLineComment(input) {
  const index = input.indexOf(NewLine);
  const result = IsEqual(index, -1) ? "" : input.slice(index);
  return result;
}
function TrimStartUntilNewline(input) {
  return input.replace(/^[ \t\r\f\v]+/, "");
}
function TrimWhitespace(input) {
  const trimmed = TrimStartUntilNewline(input);
  return trimmed.startsWith(OpenComment) ? TrimWhitespace(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? TrimWhitespace(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
function Trim(input) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(OpenComment) ? Trim(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? Trim(DiscardLineComment(trimmed.slice(2))) : trimmed;
}

// node_modules/typebox/build/type/script/token/internal/optional.mjs
function Optional2(value, input) {
  return Match2(Take([value], input), (Optional4, Rest2) => [Optional4, Rest2], () => ["", input]);
}

// node_modules/typebox/build/type/script/token/internal/many.mjs
function IsDiscard(discard, input) {
  return discard.includes(input);
}
function Many(allowed, discard, input, result = "") {
  return Match2(Take(allowed, input), (Char, Rest2) => IsDiscard(discard, Char) ? Many(allowed, discard, Rest2, result) : Many(allowed, discard, Rest2, `${result}${Char}`), () => [result, input]);
}

// node_modules/typebox/build/type/script/token/unsigned_integer.mjs
function TakeNonZero(input) {
  return Take(NonZero, input);
}
var AllowedDigits = [...Digit, UnderScore];
function TakeDigits(input) {
  return Many(AllowedDigits, [UnderScore], input);
}
function TakeUnsignedInteger(input) {
  return Match2(Take([Zero], input), (Zero2, ZeroRest) => [Zero2, ZeroRest], () => Match2(
    TakeNonZero(input),
    (NonZero2, NonZeroRest) => Match2(TakeDigits(NonZeroRest), (Digits, DigitsRest) => [`${NonZero2}${Digits}`, DigitsRest], () => []),
    // fail: did not match Digits
    () => []
  ));
}
function UnsignedInteger(input) {
  return TakeUnsignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/integer.mjs
function TakeSign(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedInteger(input) {
  return Match2(
    TakeSign(input),
    (Sign, SignRest) => Match2(UnsignedInteger(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Integer2(input) {
  return TakeSignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/bigint.mjs
function TakeBigInt(input) {
  return Match2(
    Integer2(input),
    (Integer3, IntegerRest) => Match2(Take(["n"], IntegerRest), (_N, NRest) => [`${Integer3}`, NRest], () => []),
    // fail: did not match 'n'
    () => []
  );
}
function BigInt3(input) {
  return TakeBigInt(input);
}

// node_modules/typebox/build/type/script/token/const.mjs
function TakeConst(const_, input) {
  return Take([const_], input);
}
function Const(const_, input) {
  return IsEqual(const_, "") ? ["", input] : const_.startsWith(NewLine) ? TakeConst(const_, TrimWhitespace(input)) : const_.startsWith(WhiteSpace) ? TakeConst(const_, input) : TakeConst(const_, Trim(input));
}

// node_modules/typebox/build/type/script/token/ident.mjs
var Initial = [...Alpha, UnderScore, DollarSign];
function TakeInitial(input) {
  return Take(Initial, input);
}
var Remaining = [...Initial, ...Digit];
function TakeRemaining(input, result = "") {
  return Match2(Take(Remaining, input), (Remaining2, RemainingRest) => TakeRemaining(RemainingRest, `${result}${Remaining2}`), () => [result, input]);
}
function TakeIdent(input) {
  return Match2(
    TakeInitial(input),
    (Initial2, InitialRest) => Match2(TakeRemaining(InitialRest), (Remaining2, RemainingRest) => [`${Initial2}${Remaining2}`, RemainingRest], () => []),
    // fail: did not match Remaining
    () => []
  );
}
function Ident(input) {
  return TakeIdent(Trim(input));
}

// node_modules/typebox/build/type/script/token/unsigned_number.mjs
var AllowedDigits2 = [...Digit, UnderScore];
function IsLeadingDot(input) {
  return IsMatch(Take([Dot], input));
}
function TakeFractional(input) {
  return Match2(Many(AllowedDigits2, [UnderScore], input), (Digits, DigitsRest) => IsEqual(Digits, "") ? [] : [Digits, DigitsRest], () => []);
}
function LeadingDot(input) {
  return Match2(
    Take([Dot], input),
    (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`0${Dot2}${Fractional}`, FractionalRest], () => []),
    // fail: did not match Fractional
    () => []
  );
}
function LeadingInteger(input) {
  return Match2(
    UnsignedInteger(input),
    (Integer3, IntegerRest) => Match2(
      Take([Dot], IntegerRest),
      (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`${Integer3}${Dot2}${Fractional}`, FractionalRest], () => [`${Integer3}`, DotRest]),
      // fail: did not match Fractional, use Integer
      () => [`${Integer3}`, IntegerRest]
    ),
    // fail: did not match Dot, use Integer
    () => []
  );
}
function TakeUnsignedNumber(input) {
  return IsLeadingDot(input) ? LeadingDot(input) : LeadingInteger(input);
}
function UnsignedNumber(input) {
  return TakeUnsignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/number.mjs
function TakeSign2(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedNumber(input) {
  return Match2(
    TakeSign2(input),
    (Sign, SignRest) => Match2(UnsignedNumber(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Number3(input) {
  return TakeSignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/until.mjs
function TakeOne(input) {
  const result = IsEqual(input, "") ? [] : [input.slice(0, 1), input.slice(1)];
  return result;
}
function IsInputMatchSentinal(end, input) {
  return ShiftLeft(end, (left, right) => input.startsWith(left) ? true : IsInputMatchSentinal(right, input), () => false);
}
function Until(end, input, result = "") {
  return Match2(
    TakeOne(input),
    (One, Rest2) => IsInputMatchSentinal(end, input) ? [result, input] : Until(end, Rest2, `${result}${One}`),
    () => []
  );
}

// node_modules/typebox/build/type/script/token/span.mjs
function MultiLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, Rest3) => [`${Until2}`, Rest3], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function SingleLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([NewLine, end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, EndRest) => [`${Until2}`, EndRest], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function Span(start, end, multiLine, input) {
  return multiLine ? MultiLine(start, end, Trim(input)) : SingleLine(start, end, Trim(input));
}

// node_modules/typebox/build/type/script/token/string.mjs
function TakeInitial2(quotes, input) {
  return Take(quotes, input);
}
function TakeSpan(quote, input) {
  return Span(quote, quote, false, input);
}
function TakeString(quotes, input) {
  return Match2(TakeInitial2(quotes, input), (Initial2, InitialRest) => TakeSpan(Initial2, `${Initial2}${InitialRest}`), () => []);
}
function String3(quotes, input) {
  return TakeString(quotes, Trim(input));
}

// node_modules/typebox/build/type/script/token/until_1.mjs
function Until_1(end, input) {
  return Match2(Until(end, input), (Until2, UntilRest) => IsEqual(Until2, "") ? [] : [Until2, UntilRest], () => []);
}

// node_modules/typebox/build/type/script/parser.mjs
var If = (result, left, right = () => []) => result.length === 2 ? left(result) : right();
var GenericParameterExtendsEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [GenericParameterExtendsEqualsMapping(_0), input2]);
var GenericParameterExtends = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterExtendsMapping(_0), input2]);
var GenericParameterEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterEqualsMapping(_0), input2]);
var GenericParameterIdentifier = (input) => If(Ident(input), ([_0, input2]) => [GenericParameterIdentifierMapping(_0), input2]);
var GenericParameter = (input) => If(If(GenericParameterExtendsEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterExtends(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterIdentifier(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [GenericParameterMapping(_0), input2]);
var GenericParameterList_0 = (input, result = []) => If(If(GenericParameter(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericParameterList_0(input2, [...result, _0]), () => [result, input]);
var GenericParameterList = (input) => If(If(GenericParameterList_0(input), ([_0, input2]) => If(If(If(GenericParameter(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericParameterListMapping(_0), input2]);
var GenericParameters = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericParameterList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParametersMapping(_0), input2]);
var GenericCallArgumentList_0 = (input, result = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericCallArgumentList_0(input2, [...result, _0]), () => [result, input]);
var GenericCallArgumentList = (input) => If(If(GenericCallArgumentList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallArgumentListMapping(_0), input2]);
var GenericCallArguments = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericCallArgumentList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericCallArgumentsMapping(_0), input2]);
var GenericCall = (input) => If(If(Ident(input), ([_0, input2]) => If(GenericCallArguments(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallMapping(_0), input2]);
var OptionalSemiColon = (input) => If(If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalSemiColonMapping(_0), input2]);
var KeywordString = (input) => If(Const("string", input), ([_0, input2]) => [KeywordStringMapping(_0), input2]);
var KeywordNumber = (input) => If(Const("number", input), ([_0, input2]) => [KeywordNumberMapping(_0), input2]);
var KeywordBoolean = (input) => If(Const("boolean", input), ([_0, input2]) => [KeywordBooleanMapping(_0), input2]);
var KeywordUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [KeywordUndefinedMapping(_0), input2]);
var KeywordNull = (input) => If(Const("null", input), ([_0, input2]) => [KeywordNullMapping(_0), input2]);
var KeywordInteger = (input) => If(Const("integer", input), ([_0, input2]) => [KeywordIntegerMapping(_0), input2]);
var KeywordBigInt = (input) => If(Const("bigint", input), ([_0, input2]) => [KeywordBigIntMapping(_0), input2]);
var KeywordUnknown = (input) => If(Const("unknown", input), ([_0, input2]) => [KeywordUnknownMapping(_0), input2]);
var KeywordAny = (input) => If(Const("any", input), ([_0, input2]) => [KeywordAnyMapping(_0), input2]);
var KeywordObject = (input) => If(Const("object", input), ([_0, input2]) => [KeywordObjectMapping(_0), input2]);
var KeywordNever = (input) => If(Const("never", input), ([_0, input2]) => [KeywordNeverMapping(_0), input2]);
var KeywordSymbol = (input) => If(Const("symbol", input), ([_0, input2]) => [KeywordSymbolMapping(_0), input2]);
var KeywordVoid = (input) => If(Const("void", input), ([_0, input2]) => [KeywordVoidMapping(_0), input2]);
var KeywordThis = (input) => If(Const("this", input), ([_0, input2]) => [KeywordThisMapping(_0), input2]);
var TemplateInterpolate = (input) => If(If(Const("${", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateInterpolateMapping(_0), input2]);
var TemplateSpan = (input) => If(Until(["${", "`"], input), ([_0, input2]) => [TemplateSpanMapping(_0), input2]);
var TemplateBody = (input) => If(If(If(TemplateSpan(input), ([_0, input2]) => If(TemplateInterpolate(input2), ([_1, input3]) => If(TemplateBody(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [TemplateBodyMapping(_0), input2]);
var TemplateLiteralTypes = (input) => If(If(Const("`", input), ([_0, input2]) => If(TemplateBody(input2), ([_1, input3]) => If(Const("`", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateLiteralTypesMapping(_0), input2]);
var TemplateLiteral = (input) => If(TemplateLiteralTypes(input), ([_0, input2]) => [TemplateLiteralMapping(_0), input2]);
var Dependent2 = (input) => If(If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const("else", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [DependentMapping(_0), input2]);
var LiteralBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [LiteralBigIntMapping(_0), input2]);
var LiteralBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [LiteralBooleanMapping(_0), input2]);
var LiteralNumber = (input) => If(Number3(input), ([_0, input2]) => [LiteralNumberMapping(_0), input2]);
var LiteralString = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [LiteralStringMapping(_0), input2]);
var KeyOf = (input) => If(If(If(Const("keyof", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [KeyOfMapping(_0), input2]);
var IndexArray_0 = (input, result = []) => If(If(If(Const("[", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(Const("[", input), ([_0, input2]) => If(Const("]", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => IndexArray_0(input2, [...result, _0]), () => [result, input]);
var IndexArray = (input) => If(IndexArray_0(input), ([_0, input2]) => [IndexArrayMapping(_0), input2]);
var Extends2 = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const(":", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExtendsMapping(_0), input2]);
var Base = (input) => If(If(If(Const("(", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(KeywordString(input), ([_0, input2]) => [_0, input2], () => If(KeywordNumber(input), ([_0, input2]) => [_0, input2], () => If(KeywordBoolean(input), ([_0, input2]) => [_0, input2], () => If(KeywordUndefined(input), ([_0, input2]) => [_0, input2], () => If(KeywordNull(input), ([_0, input2]) => [_0, input2], () => If(KeywordInteger(input), ([_0, input2]) => [_0, input2], () => If(KeywordBigInt(input), ([_0, input2]) => [_0, input2], () => If(KeywordUnknown(input), ([_0, input2]) => [_0, input2], () => If(KeywordAny(input), ([_0, input2]) => [_0, input2], () => If(KeywordObject(input), ([_0, input2]) => [_0, input2], () => If(KeywordNever(input), ([_0, input2]) => [_0, input2], () => If(KeywordSymbol(input), ([_0, input2]) => [_0, input2], () => If(KeywordVoid(input), ([_0, input2]) => [_0, input2], () => If(KeywordThis(input), ([_0, input2]) => [_0, input2], () => If(LiteralBigInt(input), ([_0, input2]) => [_0, input2], () => If(LiteralBoolean(input), ([_0, input2]) => [_0, input2], () => If(LiteralNumber(input), ([_0, input2]) => [_0, input2], () => If(LiteralString(input), ([_0, input2]) => [_0, input2], () => If(TemplateLiteral(input), ([_0, input2]) => [_0, input2], () => If(Dependent2(input), ([_0, input2]) => [_0, input2], () => If(_Object_2(input), ([_0, input2]) => [_0, input2], () => If(_Tuple_(input), ([_0, input2]) => [_0, input2], () => If(_Constructor_(input), ([_0, input2]) => [_0, input2], () => If(_Function_2(input), ([_0, input2]) => [_0, input2], () => If(_Mapped_(input), ([_0, input2]) => [_0, input2], () => If(GenericCall(input), ([_0, input2]) => [_0, input2], () => If(Reference(input), ([_0, input2]) => [_0, input2], () => [])))))))))))))))))))))))))))), ([_0, input2]) => [BaseMapping(_0), input2]);
var With = (input) => If(If(If(Const("with", input), ([_0, input2]) => If(WithObject(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithMapping(_0), input2]);
var Factor = (input) => If(If(KeyOf(input), ([_0, input2]) => If(Base(input2), ([_1, input3]) => If(IndexArray(input3), ([_2, input4]) => If(Extends2(input4), ([_3, input5]) => If(With(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [FactorMapping(_0), input2]);
var ExprTermTail = (input) => If(If(If(Const("&", input), ([_0, input2]) => If(Factor(input2), ([_1, input3]) => If(ExprTermTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTermTailMapping(_0), input2]);
var ExprTerm = (input) => If(If(Factor(input), ([_0, input2]) => If(ExprTermTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprTermMapping(_0), input2]);
var ExprTail = (input) => If(If(If(Const("|", input), ([_0, input2]) => If(ExprTerm(input2), ([_1, input3]) => If(ExprTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTailMapping(_0), input2]);
var Expr = (input) => If(If(ExprTerm(input), ([_0, input2]) => If(ExprTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprMapping(_0), input2]);
var ExprReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprReadonlyMapping(_0), input2]);
var ExprPipe = (input) => If(If(Const("|", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprPipeMapping(_0), input2]);
var GenericType = (input) => If(If(GenericParameters(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericTypeMapping(_0), input2]);
var InferType = (input) => If(If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("extends", input3), ([_2, input4]) => If(Expr(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InferTypeMapping(_0), input2]);
var Type = (input) => If(If(InferType(input), ([_0, input2]) => [_0, input2], () => If(ExprPipe(input), ([_0, input2]) => [_0, input2], () => If(ExprReadonly(input), ([_0, input2]) => [_0, input2], () => If(Expr(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [TypeMapping(_0), input2]);
var PropertyKeyNumber = (input) => If(Number3(input), ([_0, input2]) => [PropertyKeyNumberMapping(_0), input2]);
var PropertyKeyIdent = (input) => If(Ident(input), ([_0, input2]) => [PropertyKeyIdentMapping(_0), input2]);
var PropertyKeyQuoted = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [PropertyKeyQuotedMapping(_0), input2]);
var PropertyKeyIndex = (input) => If(If(Const("[", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(If(KeywordInteger(input4), ([_02, input5]) => [_02, input5], () => If(KeywordNumber(input4), ([_02, input5]) => [_02, input5], () => If(KeywordString(input4), ([_02, input5]) => [_02, input5], () => If(KeywordSymbol(input4), ([_02, input5]) => [_02, input5], () => [])))), ([_3, input5]) => If(Const("]", input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyKeyIndexMapping(_0), input2]);
var PropertyKey = (input) => If(If(PropertyKeyNumber(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIdent(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyQuoted(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIndex(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [PropertyKeyMapping(_0), input2]);
var Readonly2 = (input) => If(If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ReadonlyMapping(_0), input2]);
var Optional3 = (input) => If(If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalMapping(_0), input2]);
var Property = (input) => If(If(Readonly2(input), ([_0, input2]) => If(PropertyKey(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => If(Const(":", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyMapping(_0), input2]);
var PropertyDelimiter = (input) => If(If(If(Const(",", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(",", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [PropertyDelimiterMapping(_0), input2]);
var PropertyList_0 = (input, result = []) => If(If(Property(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => PropertyList_0(input2, [...result, _0]), () => [result, input]);
var PropertyList = (input) => If(If(PropertyList_0(input), ([_0, input2]) => If(If(If(Property(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PropertyListMapping(_0), input2]);
var Properties = (input) => If(If(Const("{", input), ([_0, input2]) => If(PropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PropertiesMapping(_0), input2]);
var _Object_2 = (input) => If(Properties(input), ([_0, input2]) => [_Object_Mapping(_0), input2]);
var ElementNamed = (input) => If(If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ElementNamedMapping(_0), input2]);
var ElementReadonlyOptional = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ElementReadonlyOptionalMapping(_0), input2]);
var ElementReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementReadonlyMapping(_0), input2]);
var ElementOptional = (input) => If(If(Type(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementOptionalMapping(_0), input2]);
var ElementBase = (input) => If(If(ElementNamed(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonly(input), ([_0, input2]) => [_0, input2], () => If(ElementOptional(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [ElementBaseMapping(_0), input2]);
var Element = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ElementBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ElementBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementMapping(_0), input2]);
var ElementList_0 = (input, result = []) => If(If(Element(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ElementList_0(input2, [...result, _0]), () => [result, input]);
var ElementList = (input) => If(If(ElementList_0(input), ([_0, input2]) => If(If(If(Element(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementListMapping(_0), input2]);
var _Tuple_ = (input) => If(If(Const("[", input), ([_0, input2]) => If(ElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_Tuple_Mapping(_0), input2]);
var ParameterReadonlyOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [ParameterReadonlyOptionalMapping(_0), input2]);
var ParameterReadonly = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterReadonlyMapping(_0), input2]);
var ParameterOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterOptionalMapping(_0), input2]);
var ParameterType = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ParameterTypeMapping(_0), input2]);
var ParameterBase = (input) => If(If(ParameterReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterReadonly(input), ([_0, input2]) => [_0, input2], () => If(ParameterOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterType(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ParameterBaseMapping(_0), input2]);
var Parameter2 = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ParameterBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ParameterBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterMapping(_0), input2]);
var ParameterList_0 = (input, result = []) => If(If(Parameter2(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ParameterList_0(input2, [...result, _0]), () => [result, input]);
var ParameterList = (input) => If(If(ParameterList_0(input), ([_0, input2]) => If(If(If(Parameter2(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ParameterListMapping(_0), input2]);
var _Function_2 = (input) => If(If(Const("(", input), ([_0, input2]) => If(ParameterList(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => If(Const("=>", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_Function_Mapping(_0), input2]);
var _Constructor_ = (input) => If(If(Const("new", input), ([_0, input2]) => If(Const("(", input2), ([_1, input3]) => If(ParameterList(input3), ([_2, input4]) => If(Const(")", input4), ([_3, input5]) => If(Const("=>", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_Constructor_Mapping(_0), input2]);
var MappedReadonly = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedReadonlyMapping(_0), input2]);
var MappedOptional = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedOptionalMapping(_0), input2]);
var MappedAs = (input) => If(If(If(Const("as", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [MappedAsMapping(_0), input2]);
var _Mapped_ = (input) => If(If(Const("{", input), ([_0, input2]) => If(MappedReadonly(input2), ([_1, input3]) => If(Const("[", input3), ([_2, input4]) => If(Ident(input4), ([_3, input5]) => If(Const("in", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => If(MappedAs(input7), ([_6, input8]) => If(Const("]", input8), ([_7, input9]) => If(MappedOptional(input9), ([_8, input10]) => If(Const(":", input10), ([_9, input11]) => If(Type(input11), ([_10, input12]) => If(OptionalSemiColon(input12), ([_11, input13]) => If(Const("}", input13), ([_12, input14]) => [[_0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12], input14]))))))))))))), ([_0, input2]) => [_Mapped_Mapping(_0), input2]);
var Reference = (input) => If(Ident(input), ([_0, input2]) => [ReferenceMapping(_0), input2]);
var WithBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [WithBigIntMapping(_0), input2]);
var WithNumber = (input) => If(Number3(input), ([_0, input2]) => [WithNumberMapping(_0), input2]);
var WithBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithBooleanMapping(_0), input2]);
var WithString = (input) => If(String3(['"', "'"], input), ([_0, input2]) => [WithStringMapping(_0), input2]);
var WithNull = (input) => If(Const("null", input), ([_0, input2]) => [WithNullMapping(_0), input2]);
var WithUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [WithUndefinedMapping(_0), input2]);
var WithProperty = (input) => If(If(PropertyKey(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(WithValue(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithPropertyMapping(_0), input2]);
var WithPropertyList_0 = (input, result = []) => If(If(WithProperty(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithPropertyList_0(input2, [...result, _0]), () => [result, input]);
var WithPropertyList = (input) => If(If(WithPropertyList_0(input), ([_0, input2]) => If(If(If(WithProperty(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithPropertyListMapping(_0), input2]);
var WithObject = (input) => If(If(Const("{", input), ([_0, input2]) => If(WithPropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithObjectMapping(_0), input2]);
var WithElementList_0 = (input, result = []) => If(If(WithValue(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithElementList_0(input2, [...result, _0]), () => [result, input]);
var WithElementList = (input) => If(If(WithElementList_0(input), ([_0, input2]) => If(If(If(WithValue(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithElementListMapping(_0), input2]);
var WithArray = (input) => If(If(Const("[", input), ([_0, input2]) => If(WithElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithArrayMapping(_0), input2]);
var WithValue = (input) => If(If(WithBigInt(input), ([_0, input2]) => [_0, input2], () => If(WithNumber(input), ([_0, input2]) => [_0, input2], () => If(WithBoolean(input), ([_0, input2]) => [_0, input2], () => If(WithString(input), ([_0, input2]) => [_0, input2], () => If(WithNull(input), ([_0, input2]) => [_0, input2], () => If(WithUndefined(input), ([_0, input2]) => [_0, input2], () => If(WithObject(input), ([_0, input2]) => [_0, input2], () => If(WithArray(input), ([_0, input2]) => [_0, input2], () => [])))))))), ([_0, input2]) => [WithValueMapping(_0), input2]);
var PatternBigInt = (input) => If(Const("-?(?:0|[1-9][0-9]*)n", input), ([_0, input2]) => [PatternBigIntMapping(_0), input2]);
var PatternString = (input) => If(Const(".*", input), ([_0, input2]) => [PatternStringMapping(_0), input2]);
var PatternNumber = (input) => If(Const("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", input), ([_0, input2]) => [PatternNumberMapping(_0), input2]);
var PatternInteger = (input) => If(Const("-?(?:0|[1-9][0-9]*)", input), ([_0, input2]) => [PatternIntegerMapping(_0), input2]);
var PatternNever = (input) => If(Const("(?!)", input), ([_0, input2]) => [PatternNeverMapping(_0), input2]);
var PatternText = (input) => If(Until_1(["-?(?:0|[1-9][0-9]*)n", ".*", "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", "-?(?:0|[1-9][0-9]*)", "(?!)", "(", ")", "$", "|"], input), ([_0, input2]) => [PatternTextMapping(_0), input2]);
var PatternBase = (input) => If(If(PatternBigInt(input), ([_0, input2]) => [_0, input2], () => If(PatternString(input), ([_0, input2]) => [_0, input2], () => If(PatternNumber(input), ([_0, input2]) => [_0, input2], () => If(PatternInteger(input), ([_0, input2]) => [_0, input2], () => If(PatternNever(input), ([_0, input2]) => [_0, input2], () => If(PatternGroup(input), ([_0, input2]) => [_0, input2], () => If(PatternText(input), ([_0, input2]) => [_0, input2], () => []))))))), ([_0, input2]) => [PatternBaseMapping(_0), input2]);
var PatternGroup = (input) => If(If(Const("(", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternGroupMapping(_0), input2]);
var PatternUnion = (input) => If(If(If(PatternTerm(input), ([_0, input2]) => If(Const("|", input2), ([_1, input3]) => If(PatternUnion(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(PatternTerm(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [PatternUnionMapping(_0), input2]);
var PatternTerm = (input) => If(If(PatternBase(input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PatternTermMapping(_0), input2]);
var PatternBody = (input) => If(If(PatternUnion(input), ([_0, input2]) => [_0, input2], () => If(PatternTerm(input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PatternBodyMapping(_0), input2]);
var Pattern = (input) => If(If(Const("^", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const("$", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternMapping(_0), input2]);
var InterfaceDeclarationHeritageList_0 = (input, result = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => InterfaceDeclarationHeritageList_0(input2, [...result, _0]), () => [result, input]);
var InterfaceDeclarationHeritageList = (input) => If(If(InterfaceDeclarationHeritageList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [InterfaceDeclarationHeritageListMapping(_0), input2]);
var InterfaceDeclarationHeritage = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(InterfaceDeclarationHeritageList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageMapping(_0), input2]);
var InterfaceDeclarationGeneric = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(InterfaceDeclarationHeritage(input4), ([_3, input5]) => If(Properties(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [InterfaceDeclarationGenericMapping(_0), input2]);
var InterfaceDeclaration = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(InterfaceDeclarationHeritage(input3), ([_2, input4]) => If(Properties(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [InterfaceDeclarationMapping(_0), input2]);
var TypeAliasDeclarationGeneric = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [TypeAliasDeclarationGenericMapping(_0), input2]);
var TypeAliasDeclaration = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("=", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [TypeAliasDeclarationMapping(_0), input2]);
var ExportKeyword = (input) => If(If(If(Const("export", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExportKeywordMapping(_0), input2]);
var ModuleDeclarationDelimiter = (input) => If(If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ModuleDeclarationDelimiterMapping(_0), input2]);
var ModuleDeclarationList_0 = (input, result = []) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ModuleDeclarationList_0(input2, [...result, _0]), () => [result, input]);
var ModuleDeclarationList = (input) => If(If(ModuleDeclarationList_0(input), ([_0, input2]) => If(If(If(ModuleDeclaration(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleDeclarationListMapping(_0), input2]);
var ModuleDeclaration = (input) => If(If(ExportKeyword(input), ([_0, input2]) => If(If(InterfaceDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(InterfaceDeclaration(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclaration(input2), ([_02, input3]) => [_02, input3], () => [])))), ([_1, input3]) => If(OptionalSemiColon(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ModuleDeclarationMapping(_0), input2]);
var Module = (input) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleMapping(_0), input2]);
var Script = (input) => If(If(Module(input), ([_0, input2]) => [_0, input2], () => If(GenericType(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ScriptMapping(_0), input2]);

// node_modules/typebox/build/type/engine/patterns/template.mjs
function ParseTemplateIntoTypes(template) {
  const parsed = TemplateLiteralTypes(`\`${template}\``);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/encode.mjs
function JoinString(input) {
  return input.join("|");
}
function UnwrapTemplateLiteralPattern(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function EncodeLiteral(value, right, pattern) {
  return EncodeTypes(right, `${pattern}${value}`);
}
function EncodeBigInt(right, pattern) {
  return EncodeTypes(right, `${pattern}${BigIntPattern}`);
}
function EncodeInteger(right, pattern) {
  return EncodeTypes(right, `${pattern}${IntegerPattern}`);
}
function EncodeNumber(right, pattern) {
  return EncodeTypes(right, `${pattern}${NumberPattern}`);
}
function EncodeBoolean(right, pattern) {
  return EncodeType(Union([Literal("false"), Literal("true")]), right, pattern);
}
function EncodeString(right, pattern) {
  return EncodeTypes(right, `${pattern}${StringPattern}`);
}
function EncodeTemplateLiteral(templatePattern, right, pattern) {
  return EncodeTypes(right, `${pattern}${UnwrapTemplateLiteralPattern(templatePattern)}`);
}
function EncodeTemplateLiteralDeferred(types, right, pattern) {
  const templateLiteral = TemplateLiteralAction(types, {});
  const result = EncodeType(templateLiteral, right, pattern);
  return result;
}
function EncodeEnum(values, right, pattern) {
  const evaluated = EvaluateEnum(values);
  return EncodeType(evaluated, right, pattern);
}
function EncodeUnion(types, right, pattern, result = []) {
  return guard_exports.ShiftLeft(types, (head, tail) => EncodeUnion(tail, right, pattern, [...result, EncodeType(head, [], "")]), () => EncodeTypes(right, `${pattern}(${JoinString(result)})`));
}
function EncodeType(type, right, pattern) {
  return IsEnum(type) ? EncodeEnum(type.enum, right, pattern) : IsInteger2(type) ? EncodeInteger(right, pattern) : IsLiteral(type) ? EncodeLiteral(type.const, right, pattern) : IsBigInt2(type) ? EncodeBigInt(right, pattern) : IsBoolean3(type) ? EncodeBoolean(right, pattern) : IsNumber3(type) ? EncodeNumber(right, pattern) : IsString3(type) ? EncodeString(right, pattern) : IsTemplateLiteral(type) ? EncodeTemplateLiteral(type.pattern, right, pattern) : IsTemplateLiteralDeferred(type) ? EncodeTemplateLiteralDeferred(type.parameters[0], right, pattern) : IsUnion(type) ? EncodeUnion(type.anyOf, right, pattern) : NeverPattern;
}
function EncodeTypes(types, pattern) {
  return guard_exports.ShiftLeft(types, (left, right) => EncodeType(left, right, pattern), () => pattern);
}
function EncodePattern(types) {
  const encoded = EncodeTypes(types, "");
  const result = `^${encoded}$`;
  return result;
}
function TemplateLiteralEncode(types) {
  const pattern = EncodePattern(types);
  const result = TemplateLiteralCreate(pattern);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/instantiate.mjs
function TemplateLiteralAction(types, options) {
  const result = CanInstantiate(types) ? memory_exports.Update(TemplateLiteralEncode(types), {}, options) : TemplateLiteralDeferred(types, options);
  return result;
}
function TemplateLiteralInstantiate(context, state, types, options) {
  const instantiatedTypes = InstantiateTypes(context, state, types);
  return TemplateLiteralAction(instantiatedTypes, options);
}

// node_modules/typebox/build/type/types/template_literal.mjs
function TemplateLiteralDeferred(types, options = {}) {
  return Deferred("TemplateLiteral", [types], options);
}
function IsTemplateLiteralDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "TemplateLiteral");
}
function TemplateLiteralFromTypes(types) {
  return TemplateLiteralAction(types, {});
}
function TemplateLiteralFromString(template) {
  const types = ParseTemplateIntoTypes(template);
  return TemplateLiteralFromTypes(types);
}
function TemplateLiteral2(input, options = {}) {
  const type = guard_exports.IsString(input) ? TemplateLiteralFromString(input) : TemplateLiteralFromTypes(input);
  return memory_exports.Update(type, {}, options);
}
function IsTemplateLiteral(value) {
  return IsKind(value, "TemplateLiteral");
}

// node_modules/typebox/build/type/extends/result.mjs
var result_exports = {};
__export(result_exports, {
  ExtendsFalse: () => ExtendsFalse,
  ExtendsTrue: () => ExtendsTrue,
  ExtendsUnion: () => ExtendsUnion,
  IsExtendsFalse: () => IsExtendsFalse,
  IsExtendsTrue: () => IsExtendsTrue,
  IsExtendsTrueLike: () => IsExtendsTrueLike,
  IsExtendsUnion: () => IsExtendsUnion,
  Match: () => Match3
});
function ExtendsUnion(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsUnion" }, { inferred });
}
function IsExtendsUnion(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsUnion") && guard_exports.IsObject(value.inferred);
}
function ExtendsTrue(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsTrue" }, { inferred });
}
function IsExtendsTrue(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsTrue") && guard_exports.IsObject(value.inferred);
}
function ExtendsFalse() {
  return memory_exports.Create({ ["~kind"]: "ExtendsFalse" }, {});
}
function IsExtendsFalse(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], "ExtendsFalse");
}
function IsExtendsTrueLike(value) {
  return IsExtendsUnion(value) || IsExtendsTrue(value);
}
function Match3(result, true_, false_) {
  return IsExtendsTrueLike(result) ? true_(result.inferred) : false_();
}

// node_modules/typebox/build/type/extends/extends_right.mjs
function ExtendsRightInfer(inferred, name, left, right) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => ExtendsTrue(memory_exports.Assign(memory_exports.Assign(inferred, checkInferred), { [name]: left })), () => ExtendsFalse());
}
function ExtendsRightAny(inferred, _left) {
  return ExtendsTrue(inferred);
}
function ExtendsRightDependent(inferred, left, if_, then_, else_) {
  return Match3(ExtendsLeft(inferred, left, if_), (inferred2) => Match3(ExtendsLeft(inferred2, left, then_), (inferred3) => ExtendsTrue(inferred3), () => ExtendsFalse()), () => Match3(ExtendsLeft(inferred, left, else_), (inferred2) => ExtendsTrue(inferred2), () => ExtendsFalse()));
}
function ExtendsRightEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightIntersect(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsRightIntersect(inferred2, left, tail), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsRightTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightUnion(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsRightUnion(inferred, left, tail)), () => ExtendsFalse());
}
function ExtendsRight(inferred, left, right) {
  return IsAny(right) ? ExtendsRightAny(inferred, left) : IsDependent(right) ? ExtendsRightDependent(inferred, left, right.if, right.then, right.else) : IsEnum(right) ? ExtendsRightEnum(inferred, left, right.enum) : IsInfer(right) ? ExtendsRightInfer(inferred, right.name, left, right.extends) : IsIntersect(right) ? ExtendsRightIntersect(inferred, left, right.allOf) : IsTemplateLiteral(right) ? ExtendsRightTemplateLiteral(inferred, left, right.pattern) : IsUnion(right) ? ExtendsRightUnion(inferred, left, right.anyOf) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/any.mjs
function ExtendsAny(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsUnion(inferred);
}

// node_modules/typebox/build/type/extends/array.mjs
function ExtendsImmutable(left, right) {
  const isImmutableLeft = IsImmutable(left);
  const isImmutableRight = IsImmutable(right);
  return isImmutableLeft && isImmutableRight ? true : !isImmutableLeft && isImmutableRight ? true : isImmutableLeft && !isImmutableRight ? false : true;
}
function ExtendsArray(inferred, arrayLeft, left, right) {
  return IsArray2(right) ? ExtendsImmutable(arrayLeft, right) ? ExtendsLeft(inferred, left, right.items) : ExtendsFalse() : ExtendsRight(inferred, arrayLeft, right);
}

// node_modules/typebox/build/type/extends/bigint.mjs
function ExtendsBigInt(inferred, left, right) {
  return IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/boolean.mjs
function ExtendsBoolean(inferred, left, right) {
  return IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/parameters.mjs
function ParameterCompare(inferred, left, leftRest, right, rightRest) {
  const checkLeft = IsInfer(right) ? left : right;
  const checkRight = IsInfer(right) ? right : left;
  const isLeftOptional = IsOptional(left);
  const isRightOptional = IsOptional(right);
  return !isLeftOptional && isRightOptional ? ExtendsFalse() : Match3(ExtendsLeft(inferred, checkLeft, checkRight), (inferred2) => ExtendsParameters(inferred2, leftRest, rightRest), () => ExtendsFalse());
}
function ParameterRight(inferred, left, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ParameterCompare(inferred, left, leftRest, head, tail), () => IsOptional(left) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function ParametersLeft(inferred, left, rightRest) {
  return guard_exports.ShiftLeft(left, (head, tail) => ParameterRight(inferred, head, tail, rightRest), () => ExtendsTrue(inferred));
}
function ExtendsParameters(inferred, left, right) {
  return ParametersLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/return_type.mjs
function ExtendsReturnType(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/constructor.mjs
function ExtendsConstructor(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsConstructor2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["instanceType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/dependent.mjs
function ExtendsDependent(inferred, if_, then_, else_, right) {
  return Match3(ExtendsLeft(inferred, if_, right), () => ExtendsLeft(inferred, then_, right), () => ExtendsLeft(inferred, else_, right));
}

// node_modules/typebox/build/type/extends/enum.mjs
function ExtendsEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/function.mjs
function ExtendsFunction(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsFunction2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["returnType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/integer.mjs
function ExtendsInteger(inferred, left, right) {
  return IsInteger2(right) ? ExtendsTrue(inferred) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/intersect.mjs
function ExtendsIntersect(inferred, left, right) {
  const evaluated = EvaluateIntersect(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/literal.mjs
function ExtendsLiteralValue(inferred, left, right) {
  return left === right ? ExtendsTrue(inferred) : ExtendsFalse();
}
function ExtendsLiteralBigInt(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralBoolean(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralNumber(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralString(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteral(inferred, left, right) {
  return guard_exports.IsBigInt(left.const) ? ExtendsLiteralBigInt(inferred, left.const, right) : guard_exports.IsBoolean(left.const) ? ExtendsLiteralBoolean(inferred, left.const, right) : guard_exports.IsNumber(left.const) ? ExtendsLiteralNumber(inferred, left.const, right) : guard_exports.IsString(left.const) ? ExtendsLiteralString(inferred, left.const, right) : Unreachable();
}

// node_modules/typebox/build/type/extends/never.mjs
function ExtendsNever(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : ExtendsTrue(inferred);
}

// node_modules/typebox/build/type/extends/null.mjs
function ExtendsNull(inferred, left, right) {
  return IsNull2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/number.mjs
function ExtendsNumber(inferred, left, right) {
  return IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/object.mjs
function ExtendsPropertyOptional(inferred, left, right) {
  return IsOptional(left) ? IsOptional(right) ? ExtendsTrue(inferred) : ExtendsFalse() : ExtendsTrue(inferred);
}
function ExtendsProperty(inferred, left, right) {
  return (
    // Right TInfer<TNever> is TExtendsFalse
    IsInfer(right) && IsNever(right.extends) ? ExtendsFalse() : Match3(ExtendsLeft(inferred, left, right), (inferred2) => ExtendsPropertyOptional(inferred2, left, right), () => ExtendsFalse())
  );
}
function ExtractInferredProperties(keys, properties) {
  return keys.reduce((result, key) => {
    return key in properties ? IsExtendsTrueLike(properties[key]) ? { ...result, ...properties[key].inferred } : Unreachable() : Unreachable();
  }, {});
}
function ExtendsPropertiesComparer(inferred, left, right) {
  const properties = {};
  for (const rightKey of guard_exports.Keys(right)) {
    properties[rightKey] = rightKey in left ? ExtendsProperty({}, left[rightKey], right[rightKey]) : IsOptional(right[rightKey]) ? IsInfer(right[rightKey]) ? ExtendsTrue(memory_exports.Assign(inferred, { [right[rightKey].name]: right[rightKey].extends })) : ExtendsTrue(inferred) : ExtendsFalse();
  }
  const checked = guard_exports.Values(properties).every((result) => IsExtendsTrueLike(result));
  const extracted = checked ? ExtractInferredProperties(guard_exports.Keys(properties), properties) : {};
  return checked ? ExtendsTrue(extracted) : ExtendsFalse();
}
function ExtendsProperties(inferred, left, right) {
  const compared = ExtendsPropertiesComparer(inferred, left, right);
  return IsExtendsTrueLike(compared) ? ExtendsTrue(memory_exports.Assign(inferred, compared.inferred)) : ExtendsFalse();
}
function ExtendsObjectToObject(inferred, left, right) {
  return ExtendsProperties(inferred, left, right);
}
function RecordMergeInferred(left, right) {
  return guard_exports.Keys(right).reduce((result, key) => {
    return {
      ...result,
      [key]: guard_exports.HasPropertyKey(left, key) ? IsUnion(result[key]) ? Union([...result[key].anyOf, right[key]]) : Union([left[key], right[key]]) : right[key]
    };
  }, left);
}
function ExtendsRecordComparer(properties, keys, type, result) {
  return guard_exports.ShiftLeft(keys, (left, right) => Match3(ExtendsLeft({}, properties[left], type), (inferred) => ExtendsRecordComparer(properties, right, type, RecordMergeInferred(result, inferred)), () => ExtendsFalse()), () => ExtendsTrue(result));
}
function ExtendsObjectToRecord(inferred, properties, _pattern, value) {
  const keys = guard_exports.Keys(properties);
  const result = ExtendsRecordComparer(properties, keys, value, inferred);
  return result;
}
function ExtendsObject(inferred, left, right) {
  return IsRecord(right) ? ExtendsObjectToRecord(inferred, left, RecordPattern(right), RecordValue(right)) : IsObject2(right) ? ExtendsObjectToObject(inferred, left, right.properties) : ExtendsRight(inferred, _Object_(left), right);
}

// node_modules/typebox/build/type/extends/record.mjs
function FromObject2(inferred, properties) {
  return guard_exports.IsEqual(guard_exports.Keys(properties).length, 0) ? ExtendsTrue(inferred) : ExtendsFalse();
}
function FromRecord(inferred, _leftKey, leftValue, _rightKey, rightValue) {
  return ExtendsLeft(inferred, leftValue, rightValue);
}
function ExtendsRecord(inferred, leftPattern, leftValue, right) {
  return IsRecord(right) ? FromRecord(inferred, RecordPatternToType(leftPattern), leftValue, RecordPatternToType(RecordPattern(right)), RecordValue(right)) : IsObject2(right) ? FromObject2(inferred, right.properties) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/string.mjs
function ExtendsString(inferred, left, right) {
  return IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/symbol.mjs
function ExtendsSymbol(inferred, left, right) {
  return IsSymbol2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/template_literal.mjs
function ExtendsTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/inference.mjs
function Inferrable(name, type) {
  return memory_exports.Create({ "~kind": "Inferrable" }, { name, type }, {});
}
function IsInferable(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "name") && guard_exports.HasPropertyKey(value, "type") && guard_exports.IsEqual(value["~kind"], "Inferrable") && guard_exports.IsString(value.name) && guard_exports.IsObject(value.type);
}
function TryRestInferable(type) {
  return IsRest(type) ? IsInfer(type.items) ? IsArray2(type.items.extends) ? Inferrable(type.items.name, type.items.extends.items) : IsUnknown(type.items.extends) ? Inferrable(type.items.name, type.items.extends) : void 0 : Unreachable() : void 0;
}
function TryInferable(type) {
  return IsInfer(type) ? Inferrable(type.name, type.extends) : void 0;
}
function TryInferResults(rest, right, result = []) {
  return guard_exports.ShiftLeft(rest, (head, tail) => Match3(ExtendsLeft({}, head, right), () => TryInferResults(tail, right, [...result, head]), () => void 0), () => result);
}
function InferTupleResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Tuple(results) })) : ExtendsFalse();
}
function InferUnionResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Union(results) })) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/tuple.mjs
function Reverse(types) {
  return [...types].reverse();
}
function ApplyReverse(types, reversed) {
  return reversed ? Reverse(types) : types;
}
function Reversed(types) {
  const first = types.length > 0 ? types[0] : void 0;
  const inferrable = IsSchema(first) ? TryRestInferable(first) : void 0;
  return IsSchema(inferrable);
}
function ElementsCompare(inferred, reversed, left, leftRest, right, rightRest) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => Elements(checkInferred, reversed, leftRest, rightRest), () => ExtendsFalse());
}
function ElementsLeft(inferred, reversed, leftRest, right, rightRest) {
  const inferable = TryRestInferable(right);
  return (
    // Rest Inferrable Right Means we delegate to TInferTupleResult to Generate a Result
    IsInferable(inferable) ? InferTupleResult(inferred, inferable["name"], ApplyReverse(leftRest, reversed), inferable["type"]) : guard_exports.ShiftLeft(leftRest, (head, tail) => ElementsCompare(inferred, reversed, head, tail, right, rightRest), () => ExtendsFalse())
  );
}
function ElementsRight(inferred, reversed, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ElementsLeft(inferred, reversed, leftRest, head, tail), () => guard_exports.IsEqual(leftRest.length, 0) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function Elements(inferred, reversed, leftRest, rightRest) {
  return ElementsRight(inferred, reversed, leftRest, rightRest);
}
function ExtendsTupleToTuple(inferred, left, right) {
  const instantiatedRight = InstantiateElements(inferred, State([], []), right);
  const reversed = Reversed(instantiatedRight);
  return Elements(inferred, reversed, ApplyReverse(left, reversed), ApplyReverse(instantiatedRight, reversed));
}
function ExtendsTupleToArray(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable["name"], left, inferrable["type"]) : guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsLeft(inferred, head, right), (inferred2) => ExtendsTupleToArray(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsTuple(inferred, left, right) {
  const instantiatedLeft = InstantiateElements(inferred, State([], []), left);
  return IsTuple(right) ? ExtendsTupleToTuple(inferred, instantiatedLeft, right.items) : IsArray2(right) ? ExtendsTupleToArray(inferred, instantiatedLeft, right.items) : ExtendsRight(inferred, Tuple(instantiatedLeft), right);
}

// node_modules/typebox/build/type/extends/undefined.mjs
function ExtendsUndefined(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : IsUndefined2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/union.mjs
function ExtendsUnionSome(inferred, type, unionTypes) {
  return guard_exports.ShiftLeft(unionTypes, (head, tail) => Match3(ExtendsLeft(inferred, type, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsUnionSome(inferred, type, tail)), () => ExtendsFalse());
}
function ExtendsUnionLeft(inferred, left, right) {
  return guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsUnionSome(inferred, head, right), (inferred2) => ExtendsUnionLeft(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsUnion2(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable.name, left, inferrable.type) : IsUnion(right) ? ExtendsUnionLeft(inferred, left, right.anyOf) : ExtendsUnionLeft(inferred, left, [right]);
}

// node_modules/typebox/build/type/extends/unknown.mjs
function ExtendsUnknown(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/void.mjs
function ExtendsVoid(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/extends_left.mjs
function ExtendsLeft(inferred, left, right) {
  return IsAny(left) ? ExtendsAny(inferred, left, right) : IsArray2(left) ? ExtendsArray(inferred, left, left.items, right) : IsBigInt2(left) ? ExtendsBigInt(inferred, left, right) : IsBoolean3(left) ? ExtendsBoolean(inferred, left, right) : IsConstructor2(left) ? ExtendsConstructor(inferred, left.parameters, left.instanceType, right) : IsDependent(left) ? ExtendsDependent(inferred, left.if, left.then, left.else, right) : IsEnum(left) ? ExtendsEnum(inferred, left.enum, right) : IsFunction2(left) ? ExtendsFunction(inferred, left.parameters, left.returnType, right) : IsInteger2(left) ? ExtendsInteger(inferred, left, right) : IsIntersect(left) ? ExtendsIntersect(inferred, left.allOf, right) : IsLiteral(left) ? ExtendsLiteral(inferred, left, right) : IsNever(left) ? ExtendsNever(inferred, left, right) : IsNull2(left) ? ExtendsNull(inferred, left, right) : IsNumber3(left) ? ExtendsNumber(inferred, left, right) : IsObject2(left) ? ExtendsObject(inferred, left.properties, right) : IsRecord(left) ? ExtendsRecord(inferred, RecordPattern(left), RecordValue(left), right) : IsString3(left) ? ExtendsString(inferred, left, right) : IsSymbol2(left) ? ExtendsSymbol(inferred, left, right) : IsTemplateLiteral(left) ? ExtendsTemplateLiteral(inferred, left.pattern, right) : IsTuple(left) ? ExtendsTuple(inferred, left.items, right) : IsUndefined2(left) ? ExtendsUndefined(inferred, left, right) : IsUnion(left) ? ExtendsUnion2(inferred, left.anyOf, right) : IsUnknown(left) ? ExtendsUnknown(inferred, left, right) : IsVoid(left) ? ExtendsVoid(inferred, left, right) : ExtendsFalse();
}

// node_modules/typebox/build/type/engine/interface/instantiate.mjs
function InterfaceOperation(heritage, properties) {
  const result = EvaluateIntersect([...heritage, _Object_(properties)]);
  return result;
}
function InterfaceAction(heritage, properties, options) {
  const result = CanInstantiate(heritage) ? memory_exports.Update(InterfaceOperation(heritage, properties), {}, options) : InterfaceDeferred(heritage, properties, options);
  return result;
}
function InterfaceInstantiate(context, state, heritage, properties, options) {
  const instantiatedHeritage = InstantiateTypes(context, state, heritage);
  const instantiatedProperties = InstantiateProperties(context, state, properties);
  return InterfaceAction(instantiatedHeritage, instantiatedProperties, options);
}

// node_modules/typebox/build/type/action/interface.mjs
function InterfaceDeferred(heritage, properties, options = {}) {
  return Deferred("Interface", [heritage, properties], options);
}
function IsInterfaceDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "Interface");
}
function Interface(heritage, properties, options = {}) {
  return InterfaceAction(heritage, properties, options);
}

// node_modules/typebox/build/type/engine/cyclic/check.mjs
function FromRef(stack, context, ref) {
  return stack.includes(ref) ? true : FromType3([...stack, ref], context, context[ref]);
}
function FromProperties(stack, context, properties) {
  const types = PropertyValues(properties);
  return FromTypes2(stack, context, types);
}
function FromTypes2(stack, context, types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType3(stack, context, left) ? true : FromTypes2(stack, context, right), () => false);
}
function FromType3(stack, context, type) {
  return IsRef(type) ? FromRef(stack, context, type.$ref) : IsArray2(type) ? FromType3(stack, context, type.items) : IsConstructor2(type) ? FromTypes2(stack, context, [...type.parameters, type.instanceType]) : IsFunction2(type) ? FromTypes2(stack, context, [...type.parameters, type.returnType]) : IsInterfaceDeferred(type) ? FromProperties(stack, context, type.parameters[1]) : IsIntersect(type) ? FromTypes2(stack, context, type.allOf) : IsObject2(type) ? FromProperties(stack, context, type.properties) : IsUnion(type) ? FromTypes2(stack, context, type.anyOf) : IsTuple(type) ? FromTypes2(stack, context, type.items) : IsRecord(type) ? FromType3(stack, context, RecordValue(type)) : false;
}
function CyclicCheck(stack, context, type) {
  const result = FromType3(stack, context, type);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/candidates.mjs
function ResolveCandidateKeys(context, keys) {
  return keys.reduce((result, left) => {
    return CyclicCheck([left], context, context[left]) ? [...result, left] : result;
  }, []);
}
function CyclicCandidates(context) {
  const keys = PropertyKeys(context);
  const result = ResolveCandidateKeys(context, keys);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/dependencies.mjs
function FromRef2(context, ref, result) {
  return result.includes(ref) ? result : ref in context ? FromType4(context, context[ref], [...result, ref]) : Unreachable();
}
function FromProperties2(context, properties, result) {
  const types = PropertyValues(properties);
  return FromTypes3(context, types, result);
}
function FromTypes3(context, types, result) {
  return types.reduce((result2, left) => {
    return FromType4(context, left, result2);
  }, result);
}
function FromType4(context, type, result) {
  return IsRef(type) ? FromRef2(context, type.$ref, result) : IsArray2(type) ? FromType4(context, type.items, result) : IsConstructor2(type) ? FromTypes3(context, [...type.parameters, type.instanceType], result) : IsFunction2(type) ? FromTypes3(context, [...type.parameters, type.returnType], result) : IsInterfaceDeferred(type) ? FromProperties2(context, type.parameters[1], result) : IsIntersect(type) ? FromTypes3(context, type.allOf, result) : IsObject2(type) ? FromProperties2(context, type.properties, result) : IsUnion(type) ? FromTypes3(context, type.anyOf, result) : IsTuple(type) ? FromTypes3(context, type.items, result) : IsRecord(type) ? FromType4(context, RecordValue(type), result) : result;
}
function CyclicDependencies(context, key, type) {
  const result = FromType4(context, type, [key]);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/extends.mjs
function FromRef3(_ref) {
  return Any();
}
function FromProperties3(properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType5(properties[key]) };
  }, {});
}
function FromTypes4(types) {
  return types.reduce((result, left) => {
    return [...result, FromType5(left)];
  }, []);
}
function FromType5(type) {
  return IsRef(type) ? FromRef3(type.$ref) : IsArray2(type) ? _Array_(FromType5(type.items), ArrayOptions(type)) : IsConstructor2(type) ? Constructor(FromTypes4(type.parameters), FromType5(type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes4(type.parameters), FromType5(type.returnType)) : IsIntersect(type) ? Intersect(FromTypes4(type.allOf)) : IsObject2(type) ? _Object_(FromProperties3(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType5(RecordValue(type))) : IsUnion(type) ? Union(FromTypes4(type.anyOf)) : IsTuple(type) ? Tuple(FromTypes4(type.items)) : type;
}
function CyclicAnyFromParameters(defs, ref) {
  return ref in defs ? FromType5(defs[ref]) : Unknown();
}
function CyclicExtends(type) {
  return CyclicAnyFromParameters(type.$defs, type.$ref);
}

// node_modules/typebox/build/type/engine/cyclic/instantiate.mjs
function CyclicInterface(context, heritage, properties) {
  const instantiatedHeritage = InstantiateTypes(context, State([], []), heritage);
  const instantiatedProperties = InstantiateProperties({}, State([], []), properties);
  const evaluatedInterface = EvaluateIntersect([...instantiatedHeritage, _Object_(instantiatedProperties)]);
  return evaluatedInterface;
}
function CyclicDefinitions(context, dependencies) {
  const keys = guard_exports.Keys(context).filter((key) => dependencies.includes(key));
  return keys.reduce((result, key) => {
    const type = context[key];
    const instantiatedType = IsInterfaceDeferred(type) ? CyclicInterface(context, type.parameters[0], type.parameters[1]) : type;
    return { ...result, [key]: instantiatedType };
  }, {});
}
function InstantiateCyclic(context, ref, type) {
  const dependencies = CyclicDependencies(context, ref, type);
  const definitions = CyclicDefinitions(context, dependencies);
  const result = Cyclic(definitions, ref);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/target.mjs
function Resolve(defs, ref) {
  return ref in defs ? IsRef(defs[ref]) ? Resolve(defs, defs[ref].$ref) : defs[ref] : Never();
}
function CyclicTarget(defs, ref) {
  const result = Resolve(defs, ref);
  return result;
}

// node_modules/typebox/build/type/extends/extends.mjs
function Canonical(type) {
  return IsCyclic(type) ? CyclicExtends(type) : IsUnsafe(type) ? Unknown() : type;
}
function Extends(inferred, left, right) {
  const canonicalLeft = Canonical(left);
  const canonicalRight = Canonical(right);
  return ExtendsLeft(inferred, canonicalLeft, canonicalRight);
}

// node_modules/typebox/build/type/engine/evaluate/compare.mjs
var ResultEqual = "equal";
var ResultDisjoint = "disjoint";
var ResultLeftInside = "left-inside";
var ResultRightInside = "right-inside";
function Compare(left, right) {
  const extendsCheck = [
    IsUnknown(left) ? result_exports.ExtendsFalse() : Extends({}, left, right),
    IsUnknown(left) ? result_exports.ExtendsTrue({}) : Extends({}, right, left)
  ];
  return result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultEqual : result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsFalse(extendsCheck[1]) ? ResultLeftInside : result_exports.IsExtendsFalse(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultRightInside : ResultDisjoint;
}

// node_modules/typebox/build/type/engine/evaluate/broaden.mjs
function BroadFilter(type, types) {
  return types.filter((left) => {
    return Compare(type, left) === ResultRightInside ? false : true;
  });
}
function IsBroadestType(type, types) {
  const result = types.some((left) => {
    const result2 = Compare(type, left);
    return guard_exports.IsEqual(result2, ResultLeftInside) || guard_exports.IsEqual(result2, ResultEqual);
  });
  return guard_exports.IsEqual(result, false);
}
function BroadenType(type, types) {
  const evaluated = EvaluateType(type);
  return IsAny(evaluated) ? [evaluated] : IsBroadestType(evaluated, types) ? [...BroadFilter(evaluated, types), evaluated] : types;
}
function BroadenTypes(types) {
  return types.reduce((result, left) => {
    return IsObject2(left) ? [...result, left] : (
      // push
      IsNever(left) ? result : (
        // ignore
        BroadenType(left, result)
      )
    );
  }, []);
}
function Broaden(types) {
  const broadened = BroadenTypes(types);
  const flattened = Flatten(broadened);
  return flattened;
}

// node_modules/typebox/build/type/engine/evaluate/instantiate.mjs
function EvaluateAction(type, options) {
  const result = memory_exports.Update(EvaluateType(type), {}, options);
  return result;
}
function EvaluateInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return EvaluateAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/call/distribute_arguments.mjs
function CollectDistributionNames(expression, result = []) {
  return (
    // Conditional
    IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? IsRef(expression.parameters[0]) ? CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], [...result, expression.parameters[0]["$ref"]])) : CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], result)) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? IsDeferred(expression.parameters[1]) && guard_exports.IsEqual(expression.parameters[1].action, "KeyOf") && IsRef(expression.parameters[1].parameters[0]) ? [...result, expression.parameters[1].parameters[0]["$ref"]] : result : result
  );
}
function BuildDistributionArray(parameters, names) {
  return parameters.reduce((result, left) => [...result, names.includes(left.name)], []);
}
function ZipDistributionArray(arguments_, distributionArray, result = []) {
  return guard_exports.ShiftLeft(arguments_, (argumentLeft, argumentRight) => guard_exports.ShiftLeft(distributionArray, (booleanLeft, booleanRight) => ZipDistributionArray(argumentRight, booleanRight, [...result, [booleanLeft, argumentLeft]]), () => result), () => result);
}
function Expand(type) {
  return IsUnion(type) ? [...type.anyOf] : [type];
}
function Append(current, type) {
  return current.reduce((result, left) => [...result, [...left, type]], []);
}
function Cross(current, variants) {
  return variants.reduce((result, left) => {
    return [...result, ...Append(current, left)];
  }, []);
}
function Distribute2(zipped) {
  return zipped.reduce((result, left) => {
    return guard_exports.IsEqual(left[0], true) ? Cross(result, Expand(left[1])) : Cross(result, [left[1]]);
  }, [[]]);
}
function DistributeArguments(parameters, arguments_, expression) {
  const distributionNames = CollectDistributionNames(expression);
  const distributionArray = BuildDistributionArray(parameters, distributionNames);
  const zippedArguments = ZipDistributionArray(arguments_, distributionArray);
  return IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? Distribute2(zippedArguments) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? Distribute2(zippedArguments) : [arguments_];
}

// node_modules/typebox/build/type/engine/call/resolve_target.mjs
function FromNotResolvable() {
  return ["(not-resolvable)", Never()];
}
function FromNotGeneric() {
  return ["(not-generic)", Never()];
}
function FromGeneric(name, parameters, expression) {
  return [name, Generic(parameters, expression)];
}
function FromRef4(context, ref, arguments_) {
  return ref in context ? FromType6(context, ref, context[ref], arguments_) : FromNotResolvable();
}
function FromType6(context, name, target, arguments_) {
  return IsGeneric(target) ? FromGeneric(name, target.parameters, target.expression) : IsRef(target) ? FromRef4(context, target.$ref, arguments_) : FromNotGeneric();
}
function ResolveTarget(context, target, arguments_) {
  return FromType6(context, "(anonymous)", target, arguments_);
}

// node_modules/typebox/build/type/engine/call/resolve_arguments.mjs
function AssertArgumentExtends(name, type, extends_) {
  if (IsInfer(type) || IsCall(type) || result_exports.IsExtendsTrueLike(Extends({}, type, extends_)))
    return;
  const cause = { parameter: name, expect: extends_, actual: type };
  throw new Error(`Argument for parameter ${name} does not satisfy constraint`, { cause });
}
function BindArgument(context, state, name, extends_, type) {
  const instantiatedArgument = InstantiateType(context, state, type);
  AssertArgumentExtends(name, instantiatedArgument, extends_);
  return memory_exports.Assign(context, { [name]: instantiatedArgument });
}
function BindArguments(context, state, parameterLeft, parameterRight, arguments_) {
  const instantiatedExtends = InstantiateType(context, state, parameterLeft.extends);
  const instantiatedEquals = InstantiateType(context, state, parameterLeft.equals);
  return guard_exports.ShiftLeft(arguments_, (left, right) => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, left), state, parameterRight, right), () => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, instantiatedEquals), state, parameterRight, []));
}
function BindParameters(context, state, parameters, arguments_) {
  return guard_exports.ShiftLeft(parameters, (left, right) => BindArguments(context, state, left, right, arguments_), () => context);
}
function ResolveArgumentsContext(context, state, parameters, arguments_) {
  return BindParameters(context, state, parameters, arguments_);
}

// node_modules/typebox/build/type/engine/call/instantiate.mjs
function Peek(state) {
  const result = guard_exports.IsGreaterThan(state.callstack.length, 0) ? state.callstack[state.callstack.length - 1] : "";
  return result;
}
function IsTailCall(state, name) {
  const result = guard_exports.IsEqual(Peek(state), name);
  return result;
}
function CallDispatch(context, state, target, parameters, expression, arguments_) {
  const argumentsContext = ResolveArgumentsContext(context, state, parameters, arguments_);
  const returnType = InstantiateType(argumentsContext, State([...state["callstack"], target["$ref"]], state["visited"]), expression);
  return InstantiateType(argumentsContext, State([], []), returnType);
}
function CallDistributed(context, state, target, parameters, expression, distributedArguments) {
  return distributedArguments.reduce((result, arguments_) => [...result, CallDispatch(context, state, target, parameters, expression, arguments_)], []);
}
function CallImmediate(context, state, target, parameters, expression, arguments_) {
  const distributedArguments = DistributeArguments(parameters, arguments_, expression);
  const returnTypes = CallDistributed(context, state, target, parameters, expression, distributedArguments);
  const result = guard_exports.IsEqual(returnTypes.length, 1) ? returnTypes[0] : EvaluateUnion(returnTypes);
  return result;
}
function CallInstantiate(context, state, target, arguments_) {
  const instantiatedArguments = InstantiateTypes(context, state, arguments_);
  const resolved = ResolveTarget(context, target, arguments_);
  const name = resolved[0];
  const type = resolved[1];
  const result = IsGeneric(type) ? IsTailCall(state, name) ? CallConstruct(Ref(name), instantiatedArguments) : CallImmediate(context, state, Ref(name), type.parameters, type.expression, instantiatedArguments) : CallConstruct(target, instantiatedArguments);
  return result;
}

// node_modules/typebox/build/type/types/call.mjs
function CallConstruct(target, arguments_) {
  return memory_exports.Create({ ["~kind"]: "Call" }, { type: "call", target, arguments: arguments_ }, {});
}
function Call(target, arguments_) {
  return CallInstantiate({}, State([], []), target, arguments_);
}
function IsCall(value) {
  return IsKind(value, "Call");
}

// node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs
function RemoveImmutableOperation(type) {
  return memory_exports.Discard(type, ["~immutable"]);
}
function RemoveImmutableAction(type, options) {
  const result = memory_exports.Update(RemoveImmutableOperation(type), {}, options);
  return result;
}
function RemoveImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/intrinsics/mapping.mjs
function ApplyMapping(mapping, value) {
  return mapping(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs
function FromLiteral3(mapping, value) {
  return guard_exports.IsString(value) ? Literal(ApplyMapping(mapping, value)) : Literal(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs
function FromTemplateLiteral(mapping, pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType7(mapping, evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/intrinsics/from_union.mjs
function FromUnion2(mapping, types) {
  const result = types.map((type) => FromType7(mapping, type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/intrinsics/from_type.mjs
function FromType7(mapping, type) {
  return IsLiteral(type) ? FromLiteral3(mapping, type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) : IsUnion(type) ? FromUnion2(mapping, type.anyOf) : type;
}

// node_modules/typebox/build/type/action/capitalize.mjs
function CapitalizeDeferred(type, options = {}) {
  return Deferred("Capitalize", [type], options);
}
function Capitalize(type, options = {}) {
  return CapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/lowercase.mjs
function LowercaseDeferred(type, options = {}) {
  return Deferred("Lowercase", [type], options);
}
function Lowercase(type, options = {}) {
  return LowercaseAction(type, options);
}

// node_modules/typebox/build/type/action/uncapitalize.mjs
function UncapitalizeDeferred(type, options = {}) {
  return Deferred("Uncapitalize", [type], options);
}
function Uncapitalize(type, options = {}) {
  return UncapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/uppercase.mjs
function UppercaseDeferred(type, options = {}) {
  return Deferred("Uppercase", [type], options);
}
function Uppercase(type, options = {}) {
  return UppercaseAction(type, options);
}

// node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs
var CapitalizeMapping = (input) => input[0].toUpperCase() + input.slice(1);
var LowercaseMapping = (input) => input.toLowerCase();
var UncapitalizeMapping = (input) => input[0].toLowerCase() + input.slice(1);
var UppercaseMapping = (input) => input.toUpperCase();
function CapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(CapitalizeMapping, type), {}, options) : CapitalizeDeferred(type, options);
  return result;
}
function LowercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(LowercaseMapping, type), {}, options) : LowercaseDeferred(type, options);
  return result;
}
function UncapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UncapitalizeMapping, type), {}, options) : UncapitalizeDeferred(type, options);
  return result;
}
function UppercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UppercaseMapping, type), {}, options) : UppercaseDeferred(type, options);
  return result;
}
function CapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return CapitalizeAction(instantiatedType, options);
}
function LowercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return LowercaseAction(instantiatedType, options);
}
function UncapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UncapitalizeAction(instantiatedType, options);
}
function UppercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UppercaseAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/conditional.mjs
function ConditionalDeferred(left, right, true_, false_, options = {}) {
  return Deferred("Conditional", [left, right, true_, false_], options);
}
function Conditional(left, right, true_, false_, options = {}) {
  return ConditionalAction({}, State([], []), left, right, true_, false_, options);
}

// node_modules/typebox/build/type/engine/conditional/instantiate.mjs
function ConditionalOperation(context, state, left, right, true_, false_) {
  const extendsResult = Extends(context, left, right);
  return result_exports.IsExtendsUnion(extendsResult) ? Union([InstantiateType(extendsResult.inferred, state, true_), InstantiateType(context, state, false_)]) : result_exports.IsExtendsTrue(extendsResult) ? InstantiateType(extendsResult.inferred, state, true_) : InstantiateType(context, state, false_);
}
function ConditionalAction(context, state, left, right, true_, false_, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ConditionalOperation(context, state, left, right, true_, false_), {}, options) : ConditionalDeferred(left, right, true_, false_, options);
  return result;
}
function ConditionalInstantiate(context, state, left, right, true_, false_, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ConditionalAction(context, state, instantiatedLeft, instantiatedRight, true_, false_, options);
}

// node_modules/typebox/build/type/action/constructor_parameters.mjs
function ConstructorParametersDeferred(type, options = {}) {
  return Deferred("ConstructorParameters", [type], options);
}
function ConstructorParameters(type, options = {}) {
  return ConstructorParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs
function ConstructorParametersOperation(type) {
  const parameters = IsConstructor2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ConstructorParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ConstructorParametersOperation(type), {}, options) : ConstructorParametersDeferred(type, options);
  return result;
}
function ConstructorParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ConstructorParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/exclude.mjs
function ExcludeDeferred(left, right, options = {}) {
  return Deferred("Exclude", [left, right], options);
}
function Exclude(left, right, options = {}) {
  return ExcludeAction(left, right, options);
}

// node_modules/typebox/build/type/engine/exclude/instantiate.mjs
function ExcludeAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExcludeOperation(left, right), {}, options) : ExcludeDeferred(left, right, options);
  return result;
}
function ExcludeInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExcludeAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/action/extract.mjs
function ExtractDeferred(left, right, options = {}) {
  return Deferred("Extract", [left, right], options);
}
function Extract(left, right, options = {}) {
  return ExtractAction(left, right, options);
}

// node_modules/typebox/build/type/engine/extract/operation.mjs
function ExtractType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [left] : [];
  return result;
}
function ExtractUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExtractType(head, right)];
  }, []);
}
function ExtractOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExtractUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/extract/instantiate.mjs
function ExtractAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExtractOperation(left, right), {}, options) : ExtractDeferred(left, right, options);
  return result;
}
function ExtractInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExtractAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs
function KeysToLiterals(keys) {
  return keys.reduce((result, left) => {
    return IsLiteralValue(left) ? [...result, Literal(left)] : result;
  }, []);
}
function KeysToIndexer(keys) {
  const literals = KeysToLiterals(keys);
  const result = Union(literals);
  return result;
}

// node_modules/typebox/build/type/action/indexed.mjs
function IndexDeferred(type, indexer, options = {}) {
  return Deferred("Index", [type, indexer], options);
}
function Index(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return IndexAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/object/from_cyclic.mjs
function FromCyclic(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType8(target);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_dependent.mjs
function FromDependent(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType8(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_intersect.mjs
function CollapseIntersectProperties(left, right) {
  const leftKeys = guard_exports.Keys(left).filter((key) => !guard_exports.HasPropertyKey(right, key));
  const rightKeys = guard_exports.Keys(right).filter((key) => !guard_exports.HasPropertyKey(left, key));
  const sharedKeys = guard_exports.Keys(left).filter((key) => guard_exports.HasPropertyKey(right, key));
  const leftProperties = leftKeys.reduce((result, key) => ({ ...result, [key]: left[key] }), {});
  const rightProperties = rightKeys.reduce((result, key) => ({ ...result, [key]: right[key] }), {});
  const sharedProperties = sharedKeys.reduce((result, key) => ({ ...result, [key]: EvaluateIntersect([left[key], right[key]]) }), {});
  const unique = memory_exports.Assign(leftProperties, rightProperties);
  const shared = memory_exports.Assign(unique, sharedProperties);
  return shared;
}
function FromIntersect(types) {
  return types.reduce((result, left) => {
    return CollapseIntersectProperties(result, FromType8(left));
  }, {});
}

// node_modules/typebox/build/type/engine/object/from_object.mjs
function FromObject3(properties) {
  return properties;
}

// node_modules/typebox/build/type/engine/object/from_tuple.mjs
function FromTuple(types) {
  const object = TupleToObject(Tuple(types));
  const result = FromType8(object);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_union.mjs
function CollapseUnionProperties(left, right) {
  const sharedKeys = guard_exports.Keys(left).filter((key) => key in right);
  const result = sharedKeys.reduce((result2, key) => {
    return { ...result2, [key]: EvaluateUnion([left[key], right[key]]) };
  }, {});
  return result;
}
function ReduceVariants(types, result) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, CollapseUnionProperties(result, FromType8(left))), () => result);
}
function FromUnion3(types) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, FromType8(left)), () => Unreachable());
}

// node_modules/typebox/build/type/engine/object/from_type.mjs
function FromType8(type) {
  return IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) : IsDependent(type) ? FromDependent(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect(type.allOf) : IsUnion(type) ? FromUnion3(type.anyOf) : IsTuple(type) ? FromTuple(type.items) : IsObject2(type) ? FromObject3(type.properties) : {};
}

// node_modules/typebox/build/type/engine/object/collapse.mjs
function CollapseToObject(type) {
  const properties = FromType8(type);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/helpers/keys.mjs
var integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");
function ConvertToIntegerKey(value) {
  const normal = `${value}`;
  return integerKeyPattern.test(normal) ? parseInt(normal) : value;
}

// node_modules/typebox/build/type/engine/indexed/from_array.mjs
function NormalizeLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function NormalizeIndexerTypes(types) {
  return types.map((type) => NormalizeIndexer(type));
}
function NormalizeIndexer(type) {
  return IsIntersect(type) ? Intersect(NormalizeIndexerTypes(type.allOf)) : IsUnion(type) ? Union(NormalizeIndexerTypes(type.anyOf)) : IsLiteral(type) ? NormalizeLiteral(type.const) : type;
}
function FromArray2(type, indexer) {
  const normalizedIndexer = NormalizeIndexer(indexer);
  const check = Extends({}, normalizedIndexer, Number2());
  const result = (
    // indexer
    result_exports.IsExtendsTrueLike(check) ? type : IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Number2() : Never()
  );
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs
function FromCyclic2(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType9(target);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_dependent.mjs
function FromDependent2(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_enum.mjs
function FromEnum(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_intersect.mjs
function FromIntersect2(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_literal.mjs
function FromLiteral4(value) {
  const result = [`${value}`];
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs
function FromTemplateLiteral2(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_union.mjs
function FromUnion4(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType9(left)];
  }, []);
}

// node_modules/typebox/build/type/engine/indexable/from_type.mjs
function FromType9(type) {
  return IsCyclic(type) ? FromCyclic2(type.$defs, type.$ref) : IsDependent(type) ? FromDependent2(type.if, type.then, type.else) : IsEnum(type) ? FromEnum(type.enum) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsLiteral(type) ? FromLiteral4(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral2(type.pattern) : IsUnion(type) ? FromUnion4(type.anyOf) : [];
}

// node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs
function ToIndexableKeys(type) {
  const result = FromType9(type);
  return result;
}

// node_modules/typebox/build/type/engine/this/expand_this.mjs
function FromTypes5(properties, types) {
  return types.map((type) => FromType10(properties, type));
}
function FromType10(properties, type) {
  return IsArray2(type) ? _Array_(FromType10(properties, type.items)) : IsConstructor2(type) ? Constructor(FromTypes5(properties, type.parameters), FromType10(properties, type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes5(properties, type.parameters), FromType10(properties, type.returnType)) : IsTuple(type) ? Tuple(FromTypes5(properties, type.items)) : IsUnion(type) ? Union(FromTypes5(properties, type.anyOf)) : IsIntersect(type) ? Intersect(FromTypes5(properties, type.allOf)) : IsThis(type) ? _Object_(properties) : type;
}
function ExpandThis(properties, type) {
  const result = FromType10(properties, type);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/from_object.mjs
function IndexProperty(properties, key) {
  const selectedType = key in properties ? properties[key] : Never();
  const result = ExpandThis(properties, selectedType);
  return result;
}
function IndexProperties(properties, keys) {
  return keys.reduce((result, left) => {
    return [...result, IndexProperty(properties, left)];
  }, []);
}
function FromIndexer(properties, indexer) {
  const keys = ToIndexableKeys(indexer);
  const variants = IndexProperties(properties, keys);
  const result = EvaluateUnion(variants);
  return result;
}
var NumericKeyPattern = new RegExp(IntegerKey);
function NumericKeys(keys) {
  const result = keys.filter((key) => NumericKeyPattern.test(key));
  return result;
}
function FromIndexerNumber(properties) {
  const keys = PropertyKeys(properties);
  const numericKeys = NumericKeys(keys);
  const variants = IndexProperties(properties, numericKeys);
  const result = EvaluateUnion(variants);
  return result;
}
function FromObject4(properties, indexer) {
  const result = IsNumber3(indexer) ? FromIndexerNumber(properties) : FromIndexer(properties, indexer);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/array_indexer.mjs
function ConvertLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function ArrayIndexerTypes(types) {
  return types.map((type) => FormatArrayIndexer(type));
}
function FormatArrayIndexer(type) {
  return IsIntersect(type) ? Intersect(ArrayIndexerTypes(type.allOf)) : IsUnion(type) ? Union(ArrayIndexerTypes(type.anyOf)) : IsLiteral(type) ? ConvertLiteral(type.const) : type;
}

// node_modules/typebox/build/type/engine/indexed/from_tuple.mjs
function IndexElementsWithIndexer(types, indexer) {
  return types.reduceRight((result, right, index) => {
    const check = Extends({}, Literal(index), indexer);
    return result_exports.IsExtendsTrueLike(check) ? [right, ...result] : result;
  }, []);
}
function FromTupleWithIndexer(types, indexer) {
  const formattedArrayIndexer = FormatArrayIndexer(indexer);
  const elements = IndexElementsWithIndexer(types, formattedArrayIndexer);
  return EvaluateUnionFast(elements);
}
function FromTupleWithoutIndexer(types) {
  return EvaluateUnionFast(types);
}
function FromTuple2(types, indexer) {
  return (
    // length (intrinsic)
    IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Literal(types.length) : IsNumber3(indexer) || IsInteger2(indexer) ? FromTupleWithoutIndexer(types) : FromTupleWithIndexer(types, indexer)
  );
}

// node_modules/typebox/build/type/engine/indexed/from_type.mjs
function FromType11(type, indexer) {
  return IsArray2(type) ? FromArray2(type.items, indexer) : IsObject2(type) ? FromObject4(type.properties, indexer) : IsTuple(type) ? FromTuple2(type.items, indexer) : Never();
}

// node_modules/typebox/build/type/engine/indexed/instantiate.mjs
function NormalizeType(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function IndexAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType11(NormalizeType(type), indexer), {}, options) : IndexDeferred(type, indexer, options);
  return result;
}
function IndexInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return IndexAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/instance_type.mjs
function InstanceTypeDeferred(type, options = {}) {
  return Deferred("InstanceType", [type], options);
}
function InstanceType(type, options = {}) {
  return InstanceTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/instance_type/instantiate.mjs
function InstanceTypeOperation(type) {
  return IsConstructor2(type) ? type["instanceType"] : Never();
}
function InstanceTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(InstanceTypeOperation(type), {}, options) : InstanceTypeDeferred(type, options);
  return result;
}
function InstanceTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return InstanceTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/keyof.mjs
function KeyOfDeferred(type, options = {}) {
  return Deferred("KeyOf", [type], options);
}
function KeyOf2(type, options = {}) {
  return KeyOfAction(type, options);
}

// node_modules/typebox/build/type/engine/keyof/from_any.mjs
function FromAny() {
  return Union([Number2(), String2(), Symbol2()]);
}

// node_modules/typebox/build/type/engine/keyof/from_array.mjs
function FromArray3(_type) {
  return Number2();
}

// node_modules/typebox/build/type/engine/keyof/from_object.mjs
function FromPropertyKeys(keys) {
  const result = keys.reduce((result2, left) => {
    return IsLiteralValue(left) ? [...result2, Literal(ConvertToIntegerKey(left))] : Unreachable();
  }, []);
  return result;
}
function FromObject5(properties) {
  const propertyKeys = guard_exports.Keys(properties);
  const variants = FromPropertyKeys(propertyKeys);
  const result = EvaluateUnionFast(variants);
  return result;
}

// node_modules/typebox/build/type/engine/keyof/from_record.mjs
function FromRecord2(type) {
  return RecordKey(type);
}

// node_modules/typebox/build/type/engine/keyof/from_tuple.mjs
function FromTuple3(types) {
  const result = types.map((_, index) => Literal(index));
  return EvaluateUnionFast(result);
}

// node_modules/typebox/build/type/engine/keyof/from_type.mjs
function FromType12(type) {
  return IsAny(type) ? FromAny() : IsArray2(type) ? FromArray3(type.items) : IsObject2(type) ? FromObject5(type.properties) : IsRecord(type) ? FromRecord2(type) : IsTuple(type) ? FromTuple3(type.items) : Never();
}

// node_modules/typebox/build/type/engine/keyof/instantiate.mjs
function NormalizeType2(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function KeyOfAction(type, options) {
  return CanInstantiate([type]) ? memory_exports.Update(FromType12(NormalizeType2(type)), {}, options) : KeyOfDeferred(type, options);
}
function KeyOfInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return KeyOfAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/mapped.mjs
function MappedDeferred(identifier, type, as, property, options = {}) {
  return Deferred("Mapped", [identifier, type, as, property], options);
}
function Mapped(identifier, type, as, property, options = {}) {
  return MappedAction({}, State([], []), identifier, type, as, property, options);
}

// node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs
function FromTemplateLiteral3(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType13(evaluated);
  return result;
}
function FromUnion5(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType13(left)];
  }, []);
}
function FromEnum2(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType13(evaluated);
  return result;
}
function FromLiteral5(value) {
  const result = guard_exports.IsNumber(value) ? [Literal(`${value}`)] : [Literal(value)];
  return result;
}
function FromType13(type) {
  const result = IsEnum(type) ? FromEnum2(type.enum) : IsLiteral(type) ? FromLiteral5(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral3(type.pattern) : IsUnion(type) ? FromUnion5(type.anyOf) : [type];
  return result;
}
function MappedVariants(type) {
  const result = FromType13(type);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs
function CanonicalAs(instantiatedAs) {
  const result = IsTemplateLiteral(instantiatedAs) ? EvaluateTemplateLiteral(instantiatedAs.pattern) : instantiatedAs;
  return result;
}
function MappedVariant(context, state, identifier, variant, as, property) {
  const variantContext = memory_exports.Assign(context, { [identifier["name"]]: variant });
  const instantiatedAs = InstantiateType(variantContext, state, as);
  const canonicalAs = CanonicalAs(instantiatedAs);
  const instantiatedProperty = InstantiateType(variantContext, state, property);
  return IsLiteralNumber(canonicalAs) || IsLiteralString(canonicalAs) ? { [canonicalAs.const]: instantiatedProperty } : {};
}
function MappedProperties(context, state, identifier, variants, as, property) {
  return variants.reduce((result, left) => {
    return [...result, MappedVariant(context, state, identifier, left, as, property)];
  }, []);
}
function MappedObjects(properties) {
  return properties.reduce((result, left) => {
    return [...result, _Object_(left)];
  }, []);
}
function MappedOperation(context, state, identifier, type, as, property) {
  const variants = MappedVariants(type);
  const mappedProperties = MappedProperties(context, state, identifier, variants, as, property);
  const mappedObjects = MappedObjects(mappedProperties);
  const result = EvaluateIntersect(mappedObjects);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/instantiate.mjs
function MappedAction(context, state, identifier, type, as, property, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(MappedOperation(context, state, identifier, type, as, property), {}, options) : MappedDeferred(identifier, type, as, property, options);
  return result;
}
function MappedInstantiate(context, state, identifier, type, as, property, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return MappedAction(context, state, identifier, instantiatedType, as, property, options);
}

// node_modules/typebox/build/type/engine/module/instantiate.mjs
function InstantiateCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateCyclic(declarationContext, key, declarations[key]) };
  }, {});
}
function InstantiateNonCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => !cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateType(declarationContext, State([], []), declarations[key]) };
  }, {});
}
function InstantiateModule(context, declarations, options) {
  const cyclicCandidates = CyclicCandidates(declarations);
  const instantiatedCyclics = InstantiateCyclics(context, declarations, cyclicCandidates);
  const instantiatedNonCyclics = InstantiateNonCyclics(context, declarations, cyclicCandidates);
  const instantiatedModule = { ...instantiatedCyclics, ...instantiatedNonCyclics };
  return memory_exports.Update(instantiatedModule, {}, options);
}
function ModuleInstantiate(context, _state, declarations, options) {
  const instantiatedModule = InstantiateModule(context, declarations, options);
  return instantiatedModule;
}

// node_modules/typebox/build/type/action/non_nullable.mjs
function NonNullableDeferred(type, options = {}) {
  return Deferred("NonNullable", [type], options);
}
function NonNullable(type, options = {}) {
  return NonNullableAction(type, options);
}

// node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs
function NonNullableOperation(type) {
  const excluded = Union([Null(), Undefined()]);
  return ExcludeAction(type, excluded, {});
}
function NonNullableAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(NonNullableOperation(type), {}, options) : NonNullableDeferred(type, options);
  return result;
}
function NonNullableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return NonNullableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/omit.mjs
function OmitDeferred(type, indexer, options = {}) {
  return Deferred("Omit", [type, indexer], options);
}
function Omit(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return OmitAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/indexable/to_indexable.mjs
function ToIndexable(type) {
  const collapsed = CollapseToObject(type);
  const result = IsObject2(collapsed) ? collapsed.properties : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/omit/from_type.mjs
function FromKeys(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? result2 : { ...result2, [key]: properties[key] };
  }, {});
  return result;
}
function FromType14(type, indexer) {
  const indexable = ToIndexable(type);
  const indexableKeys = ToIndexableKeys(indexer);
  const omitted = FromKeys(indexable, indexableKeys);
  const result = _Object_(omitted);
  return result;
}

// node_modules/typebox/build/type/engine/omit/instantiate.mjs
function OmitAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType14(type, indexer), {}, options) : OmitDeferred(type, indexer, options);
  return result;
}
function OmitInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return OmitAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/parameters.mjs
function ParametersDeferred(type, options = {}) {
  return Deferred("Parameters", [type], options);
}
function Parameters(type, options = {}) {
  return ParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/parameters/instantiate.mjs
function ParametersOperation(type) {
  const parameters = IsFunction2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ParametersOperation(type), {}, options) : ParametersDeferred(type, options);
  return result;
}
function ParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/partial.mjs
function PartialDeferred(type, options = {}) {
  return Deferred("Partial", [type], options);
}
function Partial(type, options = {}) {
  return PartialAction(type, options);
}

// node_modules/typebox/build/type/engine/partial/from_cyclic.mjs
function FromCyclic3(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType15(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_dependent.mjs
function FromDependent3(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_intersect.mjs
function FromIntersect3(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_union.mjs
function FromUnion6(types) {
  const result = types.map((type) => FromType15(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/partial/from_object.mjs
function FromObject6(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_type.mjs
function FromType15(type) {
  return IsCyclic(type) ? FromCyclic3(type.$defs, type.$ref) : IsDependent(type) ? FromDependent3(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion6(type.anyOf) : IsObject2(type) ? FromObject6(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/engine/partial/instantiate.mjs
function PartialAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType15(type), {}, options) : PartialDeferred(type, options);
  return result;
}
function PartialInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return PartialAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/pick.mjs
function PickDeferred(type, indexer, options = {}) {
  return Deferred("Pick", [type, indexer], options);
}
function Pick(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return PickAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/pick/from_type.mjs
function FromKeys2(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? memory_exports.Assign(result2, { [key]: properties[key] }) : result2;
  }, {});
  return result;
}
function FromType16(type, indexer) {
  const indexable = ToIndexable(type);
  const keys = ToIndexableKeys(indexer);
  const applied = FromKeys2(indexable, keys);
  const result = _Object_(applied);
  return result;
}

// node_modules/typebox/build/type/engine/pick/instantiate.mjs
function PickAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType16(type, indexer), {}, options) : PickDeferred(type, indexer, options);
  return result;
}
function PickInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return PickAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/readonly_object.mjs
function ReadonlyObjectDeferred(type, options = {}) {
  return Deferred("ReadonlyObject", [type], options);
}
function ReadonlyObject(type, options = {}) {
  return ReadonlyObjectAction(type, options);
}
var ReadonlyType = ReadonlyObject;

// node_modules/typebox/build/type/engine/readonly_object/from_array.mjs
function FromArray4(type) {
  const result = AddImmutable(_Array_(type));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs
function FromCyclic4(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType17(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs
function FromDependent4(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs
function FromIntersect4(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_object.mjs
function FromObject7(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddReadonly(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs
function FromTuple4(types) {
  const result = AddImmutable(Tuple(types));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_union.mjs
function FromUnion7(types) {
  const result = types.map((type) => FromType17(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/readonly_object/from_type.mjs
function FromType17(type) {
  return IsArray2(type) ? FromArray4(type.items) : IsCyclic(type) ? FromCyclic4(type.$defs, type.$ref) : IsDependent(type) ? FromDependent4(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect4(type.allOf) : IsObject2(type) ? FromObject7(type.properties) : IsTuple(type) ? FromTuple4(type.items) : IsUnion(type) ? FromUnion7(type.anyOf) : type;
}

// node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs
function ReadonlyObjectAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType17(type), {}, options) : ReadonlyObjectDeferred(type);
  return result;
}
function ReadonlyObjectInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReadonlyObjectAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/ref/instantiate.mjs
function RefInstantiate(context, state, type, ref) {
  return state.visited.includes(ref) ? type : ref in context ? InstantiateType(context, State(state["callstack"], [...state["visited"], ref]), context[ref]) : type;
}

// node_modules/typebox/build/type/engine/required/from_cyclic.mjs
function FromCyclic5(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType18(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_dependent.mjs
function FromDependent5(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_intersect.mjs
function FromIntersect5(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_union.mjs
function FromUnion8(types) {
  const result = types.map((type) => FromType18(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/required/from_object.mjs
function FromObject8(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: RemoveOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_type.mjs
function FromType18(type) {
  return IsCyclic(type) ? FromCyclic5(type.$defs, type.$ref) : IsDependent(type) ? FromDependent5(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect5(type.allOf) : IsUnion(type) ? FromUnion8(type.anyOf) : IsObject2(type) ? FromObject8(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/action/required.mjs
function RequiredDeferred(type, options = {}) {
  return Deferred("Required", [type], options);
}
function Required(type, options = {}) {
  return RequiredAction(type, options);
}

// node_modules/typebox/build/type/engine/required/instantiate.mjs
function RequiredAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType18(type), {}, options) : RequiredDeferred(type, options);
  return result;
}
function RequiredInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return RequiredAction(instaniatedType, options);
}

// node_modules/typebox/build/type/action/return_type.mjs
function ReturnTypeDeferred(type, options = {}) {
  return Deferred("ReturnType", [type], options);
}
function ReturnType(type, options = {}) {
  return ReturnTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/return_type/instantiate.mjs
function ReturnTypeOperation(type) {
  return IsFunction2(type) ? type["returnType"] : Never();
}
function ReturnTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ReturnTypeOperation(type), {}, options) : ReturnTypeDeferred(type, options);
  return result;
}
function ReturnTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReturnTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/with.mjs
function WithDeferred(type, options) {
  return Deferred("With", [type, options], {});
}
function With2(type, options) {
  return WithAction(type, options);
}

// node_modules/typebox/build/type/engine/with/instantiate.mjs
function WithAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(type, {}, options) : WithDeferred(type, options);
  return result;
}
function WithInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return WithAction(instaniatedType, options);
}

// node_modules/typebox/build/type/engine/rest/spread.mjs
function SpreadElement(type) {
  const result = IsRest(type) ? IsTuple(type.items) ? RestSpread(type.items.items) : IsInfer(type.items) ? [type] : IsRef(type.items) ? [type] : [Never()] : [type];
  return result;
}
function RestSpread(types) {
  const result = types.reduce((result2, left) => {
    return [...result2, ...SpreadElement(left)];
  }, []);
  return result;
}

// node_modules/typebox/build/type/engine/instantiate.mjs
function State(callstack, visited) {
  return { callstack, visited };
}
function CanInstantiate(types) {
  return guard_exports.ShiftLeft(types, (left, right) => IsRef(left) ? false : CanInstantiate(right), () => true);
}
function InstantiateProperties(context, state, properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: InstantiateType(context, state, properties[key]) };
  }, {});
}
function InstantiateElements(context, state, types) {
  const elements = InstantiateTypes(context, state, types);
  const result = RestSpread(elements);
  return result;
}
function InstantiateTypes(context, state, types) {
  return types.map((type) => InstantiateType(context, state, type));
}
function WithModifiers(type, instantiatedType) {
  const withOptional = IsOptional(type) ? AddOptionalAction(instantiatedType, {}) : instantiatedType;
  const withReadonly = IsReadonly(type) ? AddReadonlyAction(withOptional, {}) : withOptional;
  const withImmutable = IsImmutable(type) ? AddImmutableAction(withReadonly, {}) : withReadonly;
  return withImmutable;
}
function InstantiateDeferred(context, state, action, parameters, options) {
  return (
    // Modifiers
    guard_exports.IsEqual(action, "AddImmutable") ? AddImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveImmutable") ? RemoveImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddReadonly") ? AddReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveReadonly") ? RemoveReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddOptional") ? AddOptionalInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveOptional") ? RemoveOptionalInstantiate(context, state, parameters[0], options) : (
      // Actions
      guard_exports.IsEqual(action, "Capitalize") ? CapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Conditional") ? ConditionalInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "ConstructorParameters") ? ConstructorParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Evaluate") ? EvaluateInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Exclude") ? ExcludeInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Extract") ? ExtractInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Index") ? IndexInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "InstanceType") ? InstanceTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Interface") ? InterfaceInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "KeyOf") ? KeyOfInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Lowercase") ? LowercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Mapped") ? MappedInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "Module") ? ModuleInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "NonNullable") ? NonNullableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Pick") ? PickInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Parameters") ? ParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Partial") ? PartialInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Omit") ? OmitInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "ReadonlyObject") ? ReadonlyObjectInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Record") ? RecordInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Required") ? RequiredInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "ReturnType") ? ReturnTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "TemplateLiteral") ? TemplateLiteralInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uncapitalize") ? UncapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uppercase") ? UppercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "With") ? WithInstantiate(context, state, parameters[0], parameters[1]) : Deferred(action, parameters, options)
    )
  );
}
function InstantiateImmediate(context, state, type) {
  const instantiatedType = IsRef(type) ? RefInstantiate(context, state, type, type.$ref) : IsArray2(type) ? _Array_(InstantiateType(context, state, type.items), ArrayOptions(type)) : IsCall(type) ? CallInstantiate(context, state, type.target, type.arguments) : IsConstructor2(type) ? Constructor(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.instanceType), ConstructorOptions(type)) : IsFunction2(type) ? _Function_(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.returnType), FunctionOptions(type)) : IsDependent(type) ? Dependent(InstantiateType(context, state, type.if), InstantiateType(context, state, type.then), InstantiateType(context, state, type.else), DependentOptions(type)) : IsIntersect(type) ? Intersect(InstantiateTypes(context, state, type.allOf), IntersectOptions(type)) : IsObject2(type) ? _Object_(InstantiateProperties(context, state, type.properties), ObjectOptions(type)) : IsRecord(type) ? RecordFromPattern(RecordPattern(type), InstantiateType(context, state, RecordValue(type))) : IsRest(type) ? Rest(InstantiateType(context, state, type.items)) : IsTuple(type) ? Tuple(InstantiateElements(context, state, type.items), TupleOptions(type)) : IsUnion(type) ? Union(InstantiateTypes(context, state, type.anyOf), UnionOptions(type)) : type;
  const withModifiers = WithModifiers(type, instantiatedType);
  return withModifiers;
}
function InstantiateType(context, state, type) {
  const result = IsDeferred(type) ? InstantiateDeferred(context, state, type.action, type.parameters, type.options) : InstantiateImmediate(context, state, type);
  return result;
}
function Instantiate(context, type) {
  return InstantiateType(context, State([], []), type);
}

// node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs
function AddImmutableOperation(type) {
  return memory_exports.Update(type, { "~immutable": true }, {});
}
function AddImmutableAction(type, options) {
  const result = memory_exports.Update(AddImmutableOperation(type), {}, options);
  return result;
}
function AddImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_add_immutable.mjs
function AddImmutableDeferred(type, options = {}) {
  return Deferred("AddImmutable", [type], options);
}
function AddImmutable(type, options = {}) {
  return AddImmutableAction(type, options);
}

// node_modules/typebox/build/type/action/evaluate.mjs
function EvaluateDeferred(type, options = {}) {
  return Deferred("Evaluate", [type], options);
}
function Evaluate(type, options = {}) {
  return EvaluateAction(type, options);
}

// node_modules/typebox/build/type/action/module.mjs
function ModuleDeferred(declarations, options = {}) {
  return Deferred("Module", [declarations], options);
}
function Module2(declarations, options = {}) {
  return ModuleInstantiate({}, State([], []), declarations, options);
}

// node_modules/typebox/build/type/script/script.mjs
function Script2(...args) {
  const [context, input, options] = arguments_exports.Match(args, {
    2: (script, options2) => guard_exports.IsString(script) ? [{}, script, options2] : [script, options2, {}],
    3: (context2, script, options2) => [context2, script, options2],
    1: (script) => [{}, script, {}]
  });
  const result = Script(input);
  const parsed = guard_exports.IsArray(result) && guard_exports.IsEqual(result.length, 2) ? InstantiateType(context, State([], []), result[0]) : Never();
  return memory_exports.Update(parsed, {}, options);
}

// node_modules/typebox/build/typebox.mjs
var typebox_exports = {};
__export(typebox_exports, {
  Any: () => Any,
  Array: () => _Array_,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Call: () => Call,
  Capitalize: () => Capitalize,
  Codec: () => Codec,
  Conditional: () => Conditional,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Cyclic: () => Cyclic,
  Decode: () => Decode,
  DecodeBuilder: () => DecodeBuilder,
  Dependent: () => Dependent,
  Encode: () => Encode,
  EncodeBuilder: () => EncodeBuilder,
  Enum: () => Enum,
  Evaluate: () => Evaluate,
  Exclude: () => Exclude,
  Extends: () => Extends,
  ExtendsResult: () => result_exports,
  Extract: () => Extract,
  Function: () => _Function_,
  Generic: () => Generic,
  Identifier: () => Identifier,
  Immutable: () => Immutable,
  Index: () => Index,
  Infer: () => Infer,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Interface: () => Interface,
  Intersect: () => Intersect,
  IsAny: () => IsAny,
  IsArray: () => IsArray2,
  IsBigInt: () => IsBigInt2,
  IsBoolean: () => IsBoolean3,
  IsCall: () => IsCall,
  IsCodec: () => IsCodec,
  IsConstructor: () => IsConstructor2,
  IsCyclic: () => IsCyclic,
  IsDependent: () => IsDependent,
  IsEnum: () => IsEnum,
  IsEnumValue: () => IsEnumValue,
  IsFunction: () => IsFunction2,
  IsGeneric: () => IsGeneric,
  IsIdentifier: () => IsIdentifier,
  IsImmutable: () => IsImmutable,
  IsInfer: () => IsInfer,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect,
  IsKind: () => IsKind,
  IsLiteral: () => IsLiteral,
  IsNever: () => IsNever,
  IsNull: () => IsNull2,
  IsNumber: () => IsNumber3,
  IsObject: () => IsObject2,
  IsOptional: () => IsOptional,
  IsParameter: () => IsParameter,
  IsReadonly: () => IsReadonly,
  IsRecord: () => IsRecord,
  IsRef: () => IsRef,
  IsRefine: () => IsRefine,
  IsRest: () => IsRest,
  IsSchema: () => IsSchema,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol2,
  IsTemplateLiteral: () => IsTemplateLiteral,
  IsThis: () => IsThis,
  IsTuple: () => IsTuple,
  IsUndefined: () => IsUndefined2,
  IsUnion: () => IsUnion,
  IsUnknown: () => IsUnknown,
  IsUnsafe: () => IsUnsafe,
  IsVoid: () => IsVoid,
  KeyOf: () => KeyOf2,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module2,
  Never: () => Never,
  NonNullable: () => NonNullable,
  Null: () => Null,
  Number: () => Number2,
  Object: () => _Object_,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameter: () => Parameter,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Readonly: () => Readonly,
  ReadonlyObject: () => ReadonlyObject,
  ReadonlyType: () => ReadonlyType,
  Record: () => Record,
  RecordKey: () => RecordKey,
  RecordPattern: () => RecordPattern,
  RecordValue: () => RecordValue,
  Ref: () => Ref,
  Refine: () => Refine,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  Script: () => Script2,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral2,
  This: () => This,
  Tuple: () => Tuple,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void,
  With: () => With2
});

// node_modules/@earendil-works/pi-ai/dist/index.js
init_lazy();
init_context();
init_credential_store();
init_helpers();
init_models();
init_models_store();
init_diagnostics();
init_event_stream();
init_json_parse();

// src/main/tools/registry.ts
function toLLMTools(specs) {
  return specs.map((s) => ({ name: s.name, description: s.description, parameters: s.schema }));
}
function toMcpTools(specs) {
  return specs.filter((s) => s.risk !== "danger").map((s) => ({ name: s.name, description: s.description, inputSchema: s.schema }));
}
function ok(data, meta) {
  return { ok: true, data, meta };
}
function fail(code, message, meta, raw) {
  return { ok: false, error: { code, message, ...raw ? { raw } : {} }, meta };
}
function failFromCommand(r, fallbackCode, meta) {
  return fail(r.errorCode ?? fallbackCode, r.error ?? "\u547D\u4EE4\u6267\u884C\u5931\u8D25", meta, r.raw);
}

// src/main/tools/command.ts
function parseInterfaces(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^Interface\s/i.test(t)) continue;
    if (/^[-=]+$/.test(t)) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(t);
    if (!m) continue;
    const [, name, ipRaw, status, protocol] = m;
    if (!name || !/^[A-Za-z]/.test(name)) continue;
    const ipPart = ipRaw === "unassigned" ? void 0 : ipRaw;
    const [ip, mask] = ipPart ? ipPart.split("/") : [void 0, void 0];
    rows.push({
      name,
      ...ip ? { ip } : {},
      ...mask ? { mask } : {},
      status: status ?? "",
      protocol: protocol ?? ""
    });
  }
  return rows;
}
var getDeviceContext = {
  name: "get_device_context",
  description: "\u4E00\u6B21\u83B7\u53D6\u8BBE\u5907\u7684\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF1A\u578B\u53F7\u3001VRP \u7248\u672C\u3001\u5F53\u524D\u63D0\u793A\u7B26\u4E0E\u89C6\u56FE\u3001\u63A5\u53E3\u5217\u8868\u4E0E\u72B6\u6001\u3002\u9700\u8981\u4E86\u89E3\u8BBE\u5907\u73B0\u72B6\u65F6\u4F18\u5148\u7528\u672C\u5DE5\u5177\uFF0C\u4E0D\u8981\u9010\u6761\u53D1 display \u547D\u4EE4\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    { deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID\uFF0C\u5F62\u5982 127.0.0.1:2008" }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u8BFB\u53D6 ${args.deviceId} \u4E0A\u4E0B\u6587${d?.model ? `\uFF08${d.model}\uFF09` : ""}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const session = ctx.sessions.get(args.deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${args.deviceId}`, { ms: Date.now() - t0 });
    }
    const version = await session.exec("display version", { ...ctx.signal ? { signal: ctx.signal } : {} });
    const ifBrief = await session.exec("display ip interface brief", {
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    if (!version.ok) {
      return failFromCommand(version, "UNKNOWN", {
        ms: Date.now() - t0,
        deviceId: args.deviceId,
        settled: version.settled
      });
    }
    const model = session.model ?? "";
    const vrpVersion = session.vrpVersion ?? "";
    const interfaces = ifBrief.ok ? parseInterfaces(ifBrief.clean) : [];
    return ok(
      {
        id: session.id,
        name: session.name,
        ...model ? { model } : {},
        ...vrpVersion ? { vrpVersion } : {},
        prompt: version.prompt,
        view: version.view,
        encoding: session.encoding,
        interfaceBriefOk: ifBrief.ok,
        interfaces
      },
      { ms: Date.now() - t0, deviceId: args.deviceId, settled: version.settled }
    );
  }
};
var runShowCommand = {
  name: "run_show_command",
  description: "\u5728\u8BBE\u5907\u4E0A\u6267\u884C\u53EA\u8BFB\u547D\u4EE4\uFF08display / show / dir / more / ping / tracert \u5F00\u5934\uFF09\u3002\u8FD4\u56DE\u6E05\u6D17\u540E\u7684\u56DE\u663E\u3001\u5F53\u524D\u89C6\u56FE\u4E0E\u6210\u8D25\u5224\u5B9A\u3002\u4FEE\u6539\u914D\u7F6E\u9700\u4F7F\u7528\u914D\u7F6E\u7C7B\u5DE5\u5177\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      command: typebox_exports.String({ description: "\u53EA\u8BFB\u547D\u4EE4\uFF0C\u5982 display ospf peer" })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => `${args.command} \u2192 ${result.ok ? "\u6210\u529F" : "\u5931\u8D25"}`,
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const session = ctx.sessions.get(args.deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${args.deviceId}`, { ms: Date.now() - t0 });
    }
    if (!isReadOnlyCommand(args.command)) {
      return fail(
        "NOT_ALLOWED_IN_READ_MODE",
        `\u53EA\u8BFB\u6A21\u5F0F\u4E0D\u5141\u8BB8\u8BE5\u547D\u4EE4\uFF1A${args.command.slice(0, 40)}\u3002\u5982\u9700\u4FEE\u6539\u914D\u7F6E\uFF0C\u8BF7\u4F7F\u7528\u914D\u7F6E\u7C7B\u5DE5\u5177\u3002`,
        { ms: Date.now() - t0, deviceId: args.deviceId }
      );
    }
    const r = await session.exec(args.command, { ...ctx.signal ? { signal: ctx.signal } : {} });
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled };
    if (!r.ok) {
      return {
        ok: false,
        error: { code: r.errorCode ?? "UNKNOWN", message: r.error ?? "\u547D\u4EE4\u6267\u884C\u5931\u8D25", raw: r.clean },
        meta
      };
    }
    return ok(
      {
        clean: r.clean,
        prompt: r.prompt,
        view: r.view,
        settled: r.settled,
        ...r.hasWarning ? { hasWarning: true } : {},
        ...r.truncated ? { truncated: true } : {},
        ...r.decodeIssues ? { decodeIssues: true } : {},
        ...r.awaitingConfirm ? { awaitingConfirm: true, confirmText: r.confirmText } : {}
      },
      meta
    );
  }
};
var saveConfigSnapshot = {
  name: "save_config_snapshot",
  description: "\u91C7\u96C6\u8BBE\u5907\u5F53\u524D\u8FD0\u884C\u914D\u7F6E\u5E76\u5B58\u4E3A\u5FEB\u7167\uFF08\u53EA\u8BFB\u8BBE\u5907\uFF0C\u5199\u672C\u5730\u5E93\uFF09\u3002\u4EFB\u4F55\u914D\u7F6E\u53D8\u66F4\u524D\u90FD\u5E94\u5148\u505A\u5FEB\u7167\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      label: typebox_exports.Optional(typebox_exports.String({ description: "\u5FEB\u7167\u6807\u7B7E\uFF0C\u8BF4\u660E\u8FD9\u662F\u4EC0\u4E48\u65F6\u5019\u7684\u914D\u7F6E" }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u5FEB\u7167 ${args.deviceId}${d?.hashShort ? ` (${d.hashShort})` : ""}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const session = ctx.sessions.get(args.deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${args.deviceId}`, { ms: Date.now() - t0 });
    }
    const r = await session.exec("display current-configuration", {
      timeoutMs: 3e4,
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    if (!r.ok) {
      return failFromCommand(r, "FAILED", { ms: Date.now() - t0, deviceId: args.deviceId });
    }
    const meta = ctx.snapshots.save(
      args.deviceId,
      r.clean,
      args.label ?? `\u81EA\u52A8\u5FEB\u7167 ${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN")}`
    );
    return ok(meta, { ms: Date.now() - t0, deviceId: args.deviceId });
  }
};
var listSnapshots = {
  name: "list_snapshots",
  description: "\u5217\u51FA\u6307\u5B9A\u8BBE\u5907\u7684\u914D\u7F6E\u5FEB\u7167\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    { deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `${args.deviceId} \u5FEB\u7167 ${d?.snapshots?.length ?? 0} \u4EFD`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    return ok({ snapshots: ctx.snapshots.list(args.deviceId) }, { ms: Date.now() - t0 });
  }
};
function diffLines(oldText, newText) {
  const oldLines = oldText.split("\n").map((l) => l.trimEnd());
  const newLines = newText.split("\n").map((l) => l.trimEnd());
  const oldSet = /* @__PURE__ */ new Map();
  for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
  const newSet = /* @__PURE__ */ new Map();
  for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1);
  const added = [];
  for (const [line, count] of newSet) {
    const before = oldSet.get(line) ?? 0;
    if (count > before) added.push(line);
  }
  const removed = [];
  for (const [line, count] of oldSet) {
    const after = newSet.get(line) ?? 0;
    if (count > after) removed.push(line);
  }
  return { added, removed };
}
var diffWithSnapshot = {
  name: "diff_with_snapshot",
  description: "\u628A\u8BBE\u5907\u5F53\u524D\u8FD0\u884C\u914D\u7F6E\u4E0E\u6307\u5B9A\u5FEB\u7167\uFF08\u9ED8\u8BA4\u6700\u8FD1\u4E00\u4EFD\uFF09\u505A\u5BF9\u6BD4\uFF0C\u770B\u51FA\u6539\u4E86\u4EC0\u4E48\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      snapshotId: typebox_exports.Optional(typebox_exports.String({ description: "\u5FEB\u7167 ID\uFF0C\u4E0D\u4F20\u5219\u7528\u6700\u8FD1\u4E00\u4EFD" }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u5BF9\u6BD4 ${args.deviceId}\uFF1A${d?.changed ? "\u6709\u53D8\u5316" : "\u65E0\u53D8\u5316"}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const session = ctx.sessions.get(args.deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${args.deviceId}`, { ms: Date.now() - t0 });
    }
    const snap = args.snapshotId ? ctx.snapshots.get(args.deviceId, args.snapshotId) : ctx.snapshots.latest(args.deviceId);
    if (!snap) {
      return fail("NO_SNAPSHOT", "\u8BE5\u8BBE\u5907\u8FD8\u6CA1\u6709\u4EFB\u4F55\u5FEB\u7167\uFF0C\u8BF7\u5148\u91C7\u96C6\u5FEB\u7167", {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      });
    }
    const oldText = ctx.snapshots.read(args.deviceId, snap.id);
    if (oldText === null) {
      return fail("NO_SNAPSHOT", `\u5FEB\u7167\u6B63\u6587\u7F3A\u5931\uFF1A${snap.id}`, {
        ms: Date.now() - t0,
        deviceId: args.deviceId
      });
    }
    const r = await session.exec("display current-configuration", {
      timeoutMs: 3e4,
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    if (!r.ok) {
      return failFromCommand(r, "FAILED", { ms: Date.now() - t0, deviceId: args.deviceId });
    }
    const { added, removed } = diffLines(oldText, r.clean);
    return ok(
      {
        snapshotId: snap.id,
        changed: added.length > 0 || removed.length > 0,
        added,
        removed
      },
      { ms: Date.now() - t0, deviceId: args.deviceId }
    );
  }
};

// src/main/core/session/DeviceSession.ts
function deviceIdOf(port) {
  return `127.0.0.1:${port}`;
}
function parseVersion(text) {
  const m = /Version\s+([\w.]+)\s*\(([^)]+)\)/i.exec(text);
  if (m) {
    const model = m[2].trim().split(/\s+/)[0];
    return { model, vrpVersion: m[1] };
  }
  const only = /VRP\s*\(R\)\s*software,\s*Version\s+([\w.]+)/i.exec(text);
  return only ? { vrpVersion: only[1] } : {};
}
var DeviceSession = class _DeviceSession {
  constructor(port, name, client, deps) {
    this.deps = deps;
    this.port = port;
    this.id = deviceIdOf(port);
    this.name = name;
    this.client = client;
    this.unsubscribeRaw = client.onRawData((chunk) => {
      this.lastSeenAt = Date.now();
      deps.onRaw(this.id, chunk, this.agentDepth > 0);
    });
    this.unsubscribeClose = client.onClose((reason) => {
      this.closed = true;
      deps.onClosed(this.id, reason);
    });
  }
  id;
  port;
  name;
  model;
  vrpVersion;
  view = "other";
  encoding = "utf8";
  lastSeenAt = Date.now();
  client;
  closed = false;
  /** >0 表示当前正在执行代理下发的命令，用于给原始流打标记 */
  agentDepth = 0;
  unsubscribeRaw;
  unsubscribeClose;
  static async open(port, name, opts, deps) {
    const client = new TelnetClient(opts);
    const info = await client.connect(port);
    const session = new _DeviceSession(port, name, client, deps);
    session.encoding = info.encoding;
    session.view = info.prompt.view;
    return { session, info };
  }
  get isClosed() {
    return this.closed;
  }
  get queueLength() {
    return this.client.queueLength;
  }
  /** 程序通道：代理与工具走这里 */
  async exec(command, opts = {}) {
    this.agentDepth++;
    try {
      const result = await this.client.exec(command, opts);
      this.view = result.view;
      this.lastSeenAt = Date.now();
      this.deps.onStateChanged(this.toDevice());
      return result;
    } finally {
      this.agentDepth--;
    }
  }
  /** 交互通道：xterm 终端走这里 */
  writeInteractive(data) {
    const r = this.client.writeInteractive(data);
    if (r.accepted && !r.queued) this.view = this.view;
    return r;
  }
  /** 探测并缓存型号 / VRP 版本。失败不致命，只是拿不到默认别名建议 */
  async probeVersion() {
    try {
      const r = await this.exec("display version", { timeoutMs: 8e3 });
      if (!r.ok) return {};
      const info = parseVersion(r.clean);
      if (info.model) this.model = info.model;
      if (info.vrpVersion) this.vrpVersion = info.vrpVersion;
      this.deps.onStateChanged(this.toDevice());
      return info;
    } catch {
      return {};
    }
  }
  toDevice() {
    return {
      id: this.id,
      port: this.port,
      name: this.name,
      connected: !this.closed,
      ...this.model ? { model: this.model } : {},
      ...this.vrpVersion ? { vrpVersion: this.vrpVersion } : {},
      view: this.view,
      encoding: this.encoding,
      lastSeenAt: this.lastSeenAt
    };
  }
  close() {
    this.unsubscribeRaw();
    this.unsubscribeClose();
    this.client.close();
    this.closed = true;
  }
};

// src/main/core/store/snapshots.ts
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
var MAX_PER_DEVICE = 50;
var SnapshotStore = class {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.load();
  }
  index = { version: 1, items: [] };
  get indexFile() {
    return path.join(this.baseDir, "snapshots.json");
  }
  dirOf(deviceId) {
    return path.join(this.baseDir, "snapshots", deviceId.replace(/[^0-9a-zA-Z.-]/g, "_"));
  }
  load() {
    try {
      if (!fs.existsSync(this.indexFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
      this.index = { version: 1, items: parsed.items ?? [] };
    } catch {
      this.index = { version: 1, items: [] };
    }
  }
  persist() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), "utf8");
    fs.renameSync(tmp, this.indexFile);
  }
  save(deviceId, config, label) {
    const createdAt = Date.now();
    const id = `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const hashShort = createHash("sha256").update(config, "utf8").digest("hex").slice(0, 12);
    const dir = this.dirOf(deviceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.txt`), config, "utf8");
    const meta = {
      id,
      deviceId,
      label,
      sizeBytes: Buffer.byteLength(config, "utf8"),
      hashShort,
      createdAt
    };
    this.index.items.unshift(meta);
    this.prune(deviceId);
    this.persist();
    return meta;
  }
  /** 每设备只保留最近 MAX_PER_DEVICE 份，避免无限增长 */
  prune(deviceId) {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId);
    if (mine.length <= MAX_PER_DEVICE) return;
    const drop = new Set(mine.slice(MAX_PER_DEVICE).map((i) => i.id));
    for (const id of drop) {
      try {
        fs.rmSync(path.join(this.dirOf(deviceId), `${id}.txt`), { force: true });
      } catch {
      }
    }
    this.index.items = this.index.items.filter((i) => !drop.has(i.id));
  }
  list(deviceId) {
    return this.index.items.filter((i) => i.deviceId === deviceId);
  }
  latest(deviceId) {
    return this.list(deviceId)[0];
  }
  read(deviceId, id) {
    try {
      const file = path.join(this.dirOf(deviceId), `${id}.txt`);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  get(deviceId, id) {
    return this.index.items.find((i) => i.deviceId === deviceId && i.id === id);
  }
};

// src/main/core/store/changes.ts
import fs2 from "node:fs";
import path2 from "node:path";
var MAX_PER_DEVICE2 = 200;
var ChangeStore = class {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.load();
  }
  index = { version: 1, items: [] };
  get indexFile() {
    return path2.join(this.baseDir, "changes.json");
  }
  load() {
    try {
      if (!fs2.existsSync(this.indexFile)) return;
      const parsed = JSON.parse(fs2.readFileSync(this.indexFile, "utf8"));
      this.index = { version: 1, items: parsed.items ?? [] };
    } catch {
      this.index = { version: 1, items: [] };
    }
  }
  persist() {
    fs2.mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs2.writeFileSync(tmp, JSON.stringify(this.index, null, 2), "utf8");
    fs2.renameSync(tmp, this.indexFile);
  }
  /** 追加一条变更记录，返回完整记录 */
  add(record) {
    const full = {
      ...record,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now()
    };
    this.index.items.unshift(full);
    this.prune(record.deviceId);
    this.persist();
    return full;
  }
  list(deviceId) {
    return this.index.items.filter((i) => i.deviceId === deviceId);
  }
  latest(deviceId) {
    return this.list(deviceId)[0];
  }
  prune(deviceId) {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId);
    if (mine.length <= MAX_PER_DEVICE2) return;
    const drop = new Set(mine.slice(MAX_PER_DEVICE2).map((i) => i.id));
    this.index.items = this.index.items.filter((i) => !drop.has(i.id));
  }
};

// src/main/core/rollback.ts
var STANZA_HEADER_RE = /^(?:interface\s+\S+|ospf\s+\d+|vlan\s+\d+|acl\s+number\s+\d+|acl\s+name\s+\S+|acl\s+\S+|route-policy\s+\S+\s+\S+|isis\s+\d+|rip\s+\d+|bgp\s+\S+|ip\s+ip-prefix\s+\S+|traffic\s+(?:classifier|behavior)\s+\S+|firewall\s+zone\s+name\s+\S+|nat\s+address-group\s+\S+|dhcp\s+server\s+ip-pool\s+\S+|keychain\s+\S+|user-interface\s+\S+|aaa|mpls|bridge-domain)\b/i;
function parseConfigStanzas(text) {
  const out = { top: [], stanzas: [] };
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "#" || /^return\b/.test(trimmed) && !/^\s/.test(line)) {
      cur = null;
      continue;
    }
    if (/^\s/.test(line)) {
      if (cur) cur.lines.push(trimmed);
      else out.top.push(trimmed);
      continue;
    }
    if (STANZA_HEADER_RE.test(trimmed)) {
      cur = { header: trimmed, lines: [] };
      out.stanzas.push(cur);
      continue;
    }
    cur = null;
    out.top.push(trimmed);
  }
  return out;
}
function invertCommand(cmd) {
  const c = cmd.trim();
  return /^undo\s+/i.test(c) ? c.replace(/^undo\s+/i, "") : `undo ${c}`;
}
function keyOf(header) {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}
function minus(a, b) {
  const count = /* @__PURE__ */ new Map();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of b) {
    const n = (count.get(l) ?? 0) - 1;
    if (n <= 0) count.delete(l);
    else count.set(l, n);
  }
  return [...count.keys()].flatMap((l) => Array(count.get(l)).fill(l));
}
function genRollbackCommands(snapshotText, currentText) {
  const old = parseConfigStanzas(snapshotText);
  const now = parseConfigStanzas(currentText);
  const oldStanza = new Map(old.stanzas.map((s) => [keyOf(s.header), s]));
  const nowStanza = new Map(now.stanzas.map((s) => [keyOf(s.header), s]));
  const commands = [];
  const added = [];
  const removed = [];
  for (const [k, s] of oldStanza) {
    const n = nowStanza.get(k);
    if (!n) continue;
    const addLines = minus(n.lines, s.lines);
    if (addLines.length) {
      commands.push(s.header, ...addLines.map(invertCommand));
      added.push(...addLines);
    }
    const rmLines = minus(s.lines, n.lines);
    if (rmLines.length) {
      commands.push(s.header, ...rmLines);
      removed.push(...rmLines);
    }
  }
  for (const s of old.stanzas) {
    if (nowStanza.has(keyOf(s.header))) continue;
    commands.push(s.header, ...s.lines);
    removed.push(s.header, ...s.lines);
  }
  for (const n of now.stanzas) {
    if (!oldStanza.has(keyOf(n.header))) {
      commands.push(`undo ${n.header}`);
      added.push(n.header, ...n.lines);
    }
  }
  const addTop = minus(now.top, old.top);
  if (addTop.length) {
    commands.push(...addTop.map(invertCommand));
    added.push(...addTop);
  }
  const rmTop = minus(old.top, now.top);
  if (rmTop.length) {
    commands.push(...rmTop);
    removed.push(...rmTop);
  }
  return { commands, added, removed };
}

// src/main/tools/config.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var EXPECTATION_MODES = ["contains", "notContains", "regex"];
var expectationMode = typebox_exports.Union([
  typebox_exports.Literal("contains"),
  typebox_exports.Literal("notContains"),
  typebox_exports.Literal("regex")
]);
function checkExpectation(clean, exp) {
  switch (exp.mode) {
    case "contains":
      return clean.includes(exp.expect);
    case "notContains":
      return !clean.includes(exp.expect);
    case "regex":
      return new RegExp(exp.expect, "i").test(clean);
  }
}
function isExpectation(v) {
  if (!v || typeof v !== "object") return false;
  const e = v;
  if (typeof e.command !== "string" || !e.command.trim()) return false;
  if (typeof e.expect !== "string" || !e.expect.trim()) return false;
  return EXPECTATION_MODES.includes(e.mode);
}
async function executeCommands(session, commands, signal) {
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (classifyDanger(c).dangerous) {
      return { applied: [], blockedCommand: c };
    }
  }
  const sys = await session.exec("system-view", { ...signal ? { signal } : {} });
  if (!sys.ok) {
    return { applied: [], sysViewError: sys.error ?? "\u65E0\u6CD5\u8FDB\u5165\u7CFB\u7EDF\u89C6\u56FE" };
  }
  const applied = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    const r = await session.exec(c, {
      timeoutMs: 15e3,
      ...signal ? { signal } : {}
    });
    if (!r.ok) {
      return {
        applied,
        failed: { index: i, command: c, errorCode: r.errorCode ?? "FAILED", error: r.error ?? "\u547D\u4EE4\u6267\u884C\u5931\u8D25" }
      };
    }
    applied.push(c);
  }
  return { applied };
}
async function runExpectation(session, exp, signal) {
  const times = Math.max(1, Math.min(10, exp.times ?? 1));
  let last = "";
  for (let i = 0; i < times; i++) {
    const r = await session.exec(exp.command, {
      timeoutMs: 15e3,
      ...signal ? { signal } : {}
    });
    if (r.ok) {
      last = r.clean;
      let pass;
      try {
        pass = checkExpectation(r.clean, exp);
      } catch {
        return { pass: false, actual: r.clean, invalid: true };
      }
      if (pass) return { pass: true, actual: r.clean };
    }
    if (i < times - 1) await sleep(500);
  }
  return { pass: false, actual: last };
}
var metaOf = (t0, deviceId, settled) => ({
  ms: Date.now() - t0,
  ...deviceId ? { deviceId } : {},
  ...settled ? { settled } : {}
});
var applyConfig = {
  name: "apply_config",
  description: "\u4E0B\u53D1\u914D\u7F6E\u53D8\u66F4\u96C6\uFF08\u6838\u5FC3\u5199\u5DE5\u5177\uFF09\u3002\u81EA\u52A8\u5148\u91C7\u96C6\u5FEB\u7167 \u2192 \u9010\u6761\u4E0B\u53D1 \u2192 \u6BCF\u6761\u8BFB\u56DE\u663E\u5224\u5B9A\u6210\u8D25 \u2192 \u5168\u90E8\u6210\u529F\u540E\u518D\u7528 expectation \u6821\u9A8C\u3002\u4EFB\u4E00\u547D\u4EE4\u5931\u8D25\u7ACB\u5373\u505C\u6B62\u5E76\u8FD4\u56DE\u5931\u8D25\u70B9\uFF0C\u4E0D\u81EA\u52A8\u56DE\u6EDA\uFF0C\u7531\u4F60\u5224\u65AD\u4FEE\u6B63\u6216\u56DE\u6EDA\u3002\u53D8\u66F4\u524D\u8BF7\u5148\u7528 get_device_context \u4E86\u89E3\u8BBE\u5907\u73B0\u72B6\u3002",
  risk: "write",
  scope: "device",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      commands: typebox_exports.Array(typebox_exports.String(), {
        description: "\u6309\u987A\u5E8F\u4E0B\u53D1\u7684\u914D\u7F6E\u547D\u4EE4\uFF08\u4F1A\u5148\u81EA\u52A8\u8FDB\u5165\u7CFB\u7EDF\u89C6\u56FE\uFF0C\u65E0\u9700\u5E26 system-view\uFF09"
      }),
      description: typebox_exports.String({ description: "\u53D8\u66F4\u610F\u56FE\u8BF4\u660E\uFF0C\u7528\u4E8E\u5C55\u793A\u4E0E\u53D8\u66F4\u8BB0\u5F55" }),
      expectation: typebox_exports.Optional(
        typebox_exports.Object(
          {
            command: typebox_exports.String({ description: "\u6821\u9A8C\u547D\u4EE4\uFF0C\u5982 display ospf peer" }),
            expect: typebox_exports.String({ description: "\u671F\u671B\u5185\u5BB9\uFF08contains \u5B50\u4E32 / regex \u6B63\u5219\uFF09" }),
            mode: expectationMode,
            times: typebox_exports.Optional(typebox_exports.Number({ description: "\u91CD\u8BD5\u6B21\u6570\uFF08\u542B\u9996\u6B21\uFF09\uFF0C\u7528\u4E8E\u7B49\u5F85\u6536\u655B" }))
          },
          { description: "\u671F\u671B\u6821\u9A8C\uFF1A\u5168\u90E8\u547D\u4EE4\u4E0B\u53D1\u6210\u529F\u540E\u6267\u884C\u7684\u9A8C\u8BC1" }
        )
      ),
      snapshotId: typebox_exports.Optional(typebox_exports.String({ description: "\u6307\u5B9A\u4F5C\u4E3A\u56DE\u6EDA\u4F9D\u636E\u7684\u5FEB\u7167 ID\uFF1B\u4E0D\u4F20\u5219\u81EA\u52A8\u91C7\u96C6\u4E00\u4EFD" }))
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    if (!result.ok) return result.error?.message ?? "\u4E0B\u53D1\u5931\u8D25";
    const d = result.data;
    const verifiedFlag = d?.verified === false ? "\uFF0C\u672A\u8FBE\u671F\u671B" : "";
    return `\u4E0B\u53D1 ${d?.applied?.length ?? 0} \u6761\u914D\u7F6E \u2192 \u6210\u529F${verifiedFlag}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const deviceId = args.deviceId;
    const session = ctx.sessions.get(deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${deviceId}`, metaOf(t0, deviceId));
    }
    const commands = Array.isArray(args.commands) ? args.commands.map((c) => String(c).trim()).filter((c) => c.length > 0) : [];
    if (!commands.length) return fail("BAD_PARAM", "commands \u4E0D\u80FD\u4E3A\u7A7A", metaOf(t0, deviceId));
    if (!args.description?.trim()) {
      return fail("BAD_PARAM", "\u8BF7\u63D0\u4F9B description \u8BF4\u660E\u53D8\u66F4\u610F\u56FE", metaOf(t0, deviceId));
    }
    if (args.expectation !== void 0 && !isExpectation(args.expectation)) {
      return fail("BAD_PARAM", "expectation \u975E\u6CD5\uFF1A\u9700\u63D0\u4F9B command/expect/mode", metaOf(t0, deviceId));
    }
    const description = args.description.trim();
    let snapshotId = args.snapshotId;
    let snapshotText = null;
    if (!snapshotId) {
      const cur = await session.exec("display current-configuration", {
        timeoutMs: 3e4,
        ...ctx.signal ? { signal: ctx.signal } : {}
      });
      if (!cur.ok) {
        return fail("NO_SNAPSHOT", `\u5FEB\u7167\u91C7\u96C6\u5931\u8D25\uFF1A${cur.error ?? "\u547D\u4EE4\u6267\u884C\u5931\u8D25"}`, metaOf(t0, deviceId));
      }
      snapshotText = cur.clean;
      snapshotId = ctx.snapshots.save(
        deviceId,
        cur.clean,
        `\u53D8\u66F4\u524D\u5FEB\u7167\uFF1A${description.slice(0, 40)}`
      ).id;
    } else if (!ctx.snapshots.get(deviceId, snapshotId)) {
      return fail("NO_SNAPSHOT", `\u5FEB\u7167\u4E0D\u5B58\u5728\uFF1A${snapshotId}`, metaOf(t0, deviceId));
    } else {
      snapshotText = ctx.snapshots.read(deviceId, snapshotId);
    }
    const log = (result, extra) => {
      ctx.changes.add({
        deviceId,
        kind: "apply",
        actor: "agent",
        description,
        snapshotId,
        commands,
        ...args.expectation ? { expectation: args.expectation } : {},
        result,
        ...extra ?? {}
      });
    };
    const execOutcome = await executeCommands(session, commands, ctx.signal);
    if (execOutcome.blockedCommand) {
      log("blocked", {
        error: { code: "DANGER_COMMAND_BLOCKED", message: `\u547D\u4EE4\u547D\u4E2D\u5371\u9669\u6E05\u5355\uFF0C\u5DF2\u62E6\u622A\uFF1A${execOutcome.blockedCommand}` }
      });
      return fail(
        "DANGER_COMMAND_BLOCKED",
        `\u547D\u4EE4\u547D\u4E2D\u5371\u9669\u6E05\u5355\uFF0C\u5DF2\u62E6\u622A\uFF1A${execOutcome.blockedCommand}`,
        metaOf(t0, deviceId)
      );
    }
    if (execOutcome.sysViewError) {
      return fail("FAILED", `\u65E0\u6CD5\u8FDB\u5165\u7CFB\u7EDF\u89C6\u56FE\uFF1A${execOutcome.sysViewError}`, metaOf(t0, deviceId));
    }
    const meta = metaOf(t0, deviceId);
    if (execOutcome.failed) {
      const f = execOutcome.failed;
      log("failed", {
        verified: false,
        error: { code: f.errorCode, message: f.error }
      });
      return {
        ok: false,
        error: { code: f.errorCode, message: f.error },
        data: {
          applied: execOutcome.applied,
          failed: f,
          snapshotId
        },
        meta
      };
    }
    let verified;
    let actual;
    if (args.expectation) {
      const e = await runExpectation(session, args.expectation, ctx.signal);
      verified = e.pass;
      actual = e.actual;
      if (e.invalid) {
        log("failed", { verified: false, error: { code: "BAD_PARAM", message: "\u671F\u671B\u6821\u9A8C\u7684\u547D\u4EE4\u65E0\u6CD5\u6267\u884C\u6216\u6B63\u5219\u975E\u6CD5" } });
        return fail("BAD_PARAM", "expectation \u975E\u6CD5\uFF1A\u6821\u9A8C\u547D\u4EE4\u65E0\u6CD5\u6267\u884C\u6216\u6B63\u5219\u975E\u6CD5", meta);
      }
      if (!e.pass) {
        log("failed", { verified: false, error: { code: "EXPECTATION_UNMET", message: "\u671F\u671B\u6821\u9A8C\u672A\u901A\u8FC7" } });
        return {
          ok: false,
          error: { code: "EXPECTATION_UNMET", message: "\u914D\u7F6E\u5DF2\u4E0B\u53D1\u4F46\u672A\u8FBE\u5230\u671F\u671B\u72B6\u6001\uFF0C\u8BF7\u4FEE\u6B63\u6216\u56DE\u6EDA" },
          data: { applied: execOutcome.applied, snapshotId, verified: false, actual },
          meta
        };
      }
    }
    let diff;
    if (snapshotText !== null) {
      const after = await session.exec("display current-configuration", {
        timeoutMs: 3e4,
        ...ctx.signal ? { signal: ctx.signal } : {}
      });
      if (after.ok) diff = diffLines(snapshotText, after.clean);
    }
    log("ok", { verified: verified ?? true });
    return ok(
      {
        applied: execOutcome.applied,
        snapshotId,
        ...args.expectation ? { verified: verified ?? false } : {},
        ...diff ? { diff } : {}
      },
      meta
    );
  }
};
var verifyExpectation = {
  name: "verify_expectation",
  description: "\u6267\u884C\u4E00\u6761\u547D\u4EE4\u5E76\u65AD\u8A00\u56DE\u663E\u662F\u5426\u6EE1\u8DB3\u671F\u671B\uFF08contains / notContains / regex\uFF09\uFF0C\u53EF\u9009\u91CD\u8BD5\u7B49\u5F85\u534F\u8BAE\u6536\u655B\u3002\u7528\u4E8E\u53D8\u66F4\u540E\u7684\u72B6\u6001\u9A8C\u8BC1\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      command: typebox_exports.String({ description: "\u6821\u9A8C\u547D\u4EE4\uFF0C\u5982 display ospf peer" }),
      expect: typebox_exports.String({ description: "\u671F\u671B\u5185\u5BB9" }),
      mode: expectationMode,
      times: typebox_exports.Optional(typebox_exports.Number({ description: "\u91CD\u8BD5\u6B21\u6570\uFF08\u542B\u9996\u6B21\uFF09\uFF0C\u9ED8\u8BA4 1" }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u6821\u9A8C ${args.command} \u2192 ${d?.pass ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7"}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const deviceId = args.deviceId;
    const session = ctx.sessions.get(deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${deviceId}`, metaOf(t0, deviceId));
    }
    if (!EXPECTATION_MODES.includes(args.mode)) {
      return fail("BAD_PARAM", `mode \u975E\u6CD5\uFF1A${args.mode}`, metaOf(t0, deviceId));
    }
    const exp = {
      command: args.command,
      expect: args.expect,
      mode: args.mode,
      ...Number.isFinite(args.times) ? { times: args.times } : {}
    };
    const r = await runExpectation(session, exp, ctx.signal);
    if (r.invalid) {
      return fail("BAD_PARAM", "\u6B63\u5219\u8868\u8FBE\u5F0F\u65E0\u6548\uFF0C\u65E0\u6CD5\u6821\u9A8C", metaOf(t0, deviceId));
    }
    return ok({ pass: r.pass, actual: r.actual.slice(0, 8e3) }, metaOf(t0, deviceId));
  }
};
var restoreSnapshot = {
  name: "restore_snapshot",
  description: "\u628A\u8BBE\u5907\u914D\u7F6E\u56DE\u6EDA\u5230\u6307\u5B9A\u5FEB\u7167\uFF08\u9ED8\u8BA4\u6700\u8FD1\u4E00\u4EFD\uFF09\u3002\u81EA\u52A8\u5BF9\u6BD4\u5F53\u524D\u914D\u7F6E\u751F\u6210\u64A4\u9500\u547D\u4EE4\u5E76\u4E0B\u53D1\u3002\u4E3B\u52A8\u56DE\u6EDA\u4F1A\u89E6\u53D1\u4EBA\u5DE5\u786E\u8BA4\u95F8\u95E8\uFF1B\u540C\u4E00\u4EFB\u52A1\u5185 apply_config \u5931\u8D25\u540E\u7684\u81EA\u52A8\u56DE\u6EDA\u8D70\u5185\u90E8\u8DEF\u5F84\u4E0D\u5F39\u7A97\u3002",
  risk: "write",
  scope: "device",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      snapshotId: typebox_exports.Optional(typebox_exports.String({ description: "\u76EE\u6807\u5FEB\u7167 ID\uFF0C\u4E0D\u4F20\u5219\u7528\u6700\u8FD1\u4E00\u4EFD" })),
      reason: typebox_exports.String({ description: "\u56DE\u6EDA\u539F\u56E0\uFF0C\u7528\u4E8E\u53D8\u66F4\u8BB0\u5F55" })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => result.ok ? `\u56DE\u6EDA ${args.deviceId}\uFF08\u5E94\u7528 ${result.data?.appliedCommands ?? 0} \u6761\uFF09` : "\u56DE\u6EDA\u5931\u8D25",
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const deviceId = args.deviceId;
    const session = ctx.sessions.get(deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${deviceId}`, metaOf(t0, deviceId));
    }
    if (!args.reason?.trim()) {
      return fail("BAD_PARAM", "\u8BF7\u63D0\u4F9B reason \u8BF4\u660E\u56DE\u6EDA\u539F\u56E0", metaOf(t0, deviceId));
    }
    const snap = args.snapshotId ? ctx.snapshots.get(deviceId, args.snapshotId) : ctx.snapshots.latest(deviceId);
    if (!snap) {
      return fail("NO_SNAPSHOT", "\u8BE5\u8BBE\u5907\u6CA1\u6709\u53EF\u7528\u5FEB\u7167\uFF0C\u65E0\u6CD5\u56DE\u6EDA", metaOf(t0, deviceId));
    }
    const snapText = ctx.snapshots.read(deviceId, snap.id);
    if (snapText === null) {
      return fail("NO_SNAPSHOT", `\u5FEB\u7167\u6B63\u6587\u7F3A\u5931\uFF1A${snap.id}`, metaOf(t0, deviceId));
    }
    const cur = await session.exec("display current-configuration", {
      timeoutMs: 3e4,
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    if (!cur.ok) {
      return failFromCommand(cur, "FAILED", metaOf(t0, deviceId));
    }
    const plan = genRollbackCommands(snapText, cur.clean);
    const meta = metaOf(t0, deviceId);
    const log = (result) => {
      ctx.changes.add({
        deviceId,
        kind: "restore",
        actor: "agent",
        snapshotId: snap.id,
        description: args.reason.trim(),
        commands: plan.commands,
        result,
        verified: result === "ok",
        ...result === "failed" ? { error: { code: "FAILED", message: "\u56DE\u6EDA\u547D\u4EE4\u6267\u884C\u5931\u8D25" } } : {}
      });
    };
    if (!plan.commands.length) {
      log("ok");
      return ok({ ok: true, appliedCommands: 0, upToDate: true }, meta);
    }
    const approved = await ctx.requestGate({
      toolName: "restore_snapshot",
      deviceId,
      args,
      reason: `\u56DE\u6EDA ${deviceId} \u5230\u5FEB\u7167\u300C${snap.label}\u300D`,
      consequence: "\u5C06\u64A4\u9500\u81EA\u8BE5\u5FEB\u7167\u4EE5\u6765\u6B64\u8BBE\u5907\u4E0A\u7684\u5168\u90E8\u914D\u7F6E\u53D8\u66F4\u3002\u82E5\u671F\u95F4\u6709\u4EBA\u624B\u5DE5\u6539\u52A8\u8FC7\u914D\u7F6E\uFF0C\u4E5F\u4F1A\u88AB\u4E00\u5E76\u8986\u76D6\u3002"
    });
    if (!approved) {
      log("rejected");
      return fail("GATE_REJECTED", "\u7528\u6237\u62D2\u7EDD\u4E86\u56DE\u6EDA\u64CD\u4F5C", meta);
    }
    const outcome = await executeCommands(session, plan.commands, ctx.signal);
    if (outcome.blockedCommand) {
      return fail("DANGER_COMMAND_BLOCKED", `\u56DE\u6EDA\u547D\u4EE4\u547D\u4E2D\u5371\u9669\u6E05\u5355\uFF0C\u5DF2\u4E2D\u65AD\uFF1A${outcome.blockedCommand}`, meta);
    }
    if (outcome.sysViewError) {
      return fail("FAILED", `\u65E0\u6CD5\u8FDB\u5165\u7CFB\u7EDF\u89C6\u56FE\uFF1A${outcome.sysViewError}`, meta);
    }
    if (outcome.failed) {
      const f = outcome.failed;
      log("failed");
      return {
        ok: false,
        error: { code: f.errorCode, message: f.error },
        data: { appliedCommands: outcome.applied.length, failed: f, applied: outcome.applied },
        meta
      };
    }
    log("ok");
    return ok(
      {
        ok: true,
        appliedCommands: outcome.applied.length,
        applied: outcome.applied,
        diff: { added: plan.added, removed: plan.removed }
      },
      meta
    );
  }
};
var saveConfiguration = {
  name: "save_configuration",
  description: "\u628A\u5F53\u524D\u8FD0\u884C\u914D\u7F6E\u4FDD\u5B58\u4E3A\u542F\u52A8\u914D\u7F6E\uFF08danger \u64CD\u4F5C\uFF0C\u9700\u4EBA\u5DE5\u95F8\u95E8\u6279\u51C6\uFF09\u3002VRP \u7684 save \u4F1A\u89E6\u53D1 [Y/N] \u786E\u8BA4\uFF0C\u672C\u5DE5\u5177\u83B7\u6279\u540E\u4EE3\u4E3A\u5E94\u7B54\u3002",
  risk: "danger",
  scope: "device",
  schema: typebox_exports.Object(
    { deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }) },
    { additionalProperties: false }
  ),
  summarize: () => "\u4FDD\u5B58\u914D\u7F6E\u5230\u542F\u52A8\u914D\u7F6E",
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const deviceId = args.deviceId;
    const session = ctx.sessions.get(deviceId);
    if (!session) {
      return fail("NOT_CONNECTED", `\u8BBE\u5907\u672A\u8FDE\u63A5\uFF1A${deviceId}`, metaOf(t0, deviceId));
    }
    const r = await session.exec("save", {
      timeoutMs: 15e3,
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    let okFlag = r.ok;
    let errorText = r.error;
    let errorCode = r.errorCode;
    if (okFlag && r.awaitingConfirm) {
      const y = await session.exec("y", {
        timeoutMs: 5e3,
        ...ctx.signal ? { signal: ctx.signal } : {}
      });
      okFlag = y.ok;
      errorText = y.error;
      errorCode = y.errorCode;
    }
    const latest = ctx.snapshots.latest(deviceId);
    ctx.changes.add({
      deviceId,
      kind: "save",
      actor: "agent",
      ...latest ? { snapshotId: latest.id } : {},
      description: "\u4FDD\u5B58\u914D\u7F6E\u5230\u542F\u52A8\u914D\u7F6E",
      commands: ["save"],
      result: okFlag ? "ok" : "failed",
      ...okFlag ? {} : { error: { code: errorCode ?? "FAILED", message: errorText ?? "\u4FDD\u5B58\u5931\u8D25" } }
    });
    if (!okFlag) {
      return fail(errorCode ?? "FAILED", errorText ?? "\u4FDD\u5B58\u5931\u8D25", metaOf(t0, deviceId));
    }
    return ok({ saved: true }, metaOf(t0, deviceId));
  }
};

// src/main/agent/llm/translate.ts
function newTurn() {
  return { text: "", toolCalls: [] };
}
function consumeEvent(acc, ev) {
  switch (ev.type) {
    case "text_delta":
      acc.text += ev.delta;
      return [{ type: "text", delta: ev.delta }];
    case "thinking_delta":
    case "thinking_start":
    case "thinking_end":
      return [];
    case "toolcall_end":
      acc.toolCalls.push({
        id: ev.toolCall.id,
        name: ev.toolCall.name,
        args: ev.toolCall.arguments ?? {}
      });
      return [];
    default:
      return [];
  }
}

// src/main/core/topology/model.ts
function emptyTopology() {
  return { nodes: [], links: [], updatedAt: 0 };
}
function guessRole(name, model) {
  const hay = `${model ?? ""} ${name}`.toUpperCase();
  if (/\b(AR|NE|CE|AX|USG)\d+/.test(hay)) return "router";
  if (/\bS\d|S[57]00/.test(hay)) return "switch";
  if (/\b(PC|CLOUD|SERVER)\b/.test(hay)) return "pc";
  return "unknown";
}
function linkKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function mergeTopology(discovered, manual) {
  return mergeLayers(null, discovered, manual);
}
function mergeLayers(file, discovered, manual) {
  const nodeById = /* @__PURE__ */ new Map();
  const findByDevice = (deviceId) => {
    for (const [id, n] of nodeById) {
      if (n.deviceId === deviceId || id === deviceId) return id;
    }
    return void 0;
  };
  const applyLayer = (nodes, source, override) => {
    for (const n of nodes) {
      const existingId = nodeById.has(n.id) ? n.id : n.deviceId ? findByDevice(n.deviceId) : void 0;
      if (!existingId) {
        nodeById.set(n.id, { ...n, source });
        continue;
      }
      const prev = nodeById.get(existingId);
      nodeById.set(
        existingId,
        override ? { ...prev, ...n, source: "manual", deviceId: n.deviceId ?? prev.deviceId, model: n.model ?? prev.model } : { ...n, ...prev, source: prev.source, deviceId: prev.deviceId ?? n.deviceId, model: prev.model ?? n.model }
      );
    }
  };
  if (file) applyLayer(file.nodes, "file", false);
  applyLayer(discovered.nodes, "discovered", false);
  applyLayer(manual.nodes, "manual", true);
  const byKey = /* @__PURE__ */ new Map();
  const putLink = (l) => {
    const key = linkKey(l.from, l.to);
    const prevLink = byKey.get(key);
    if (!prevLink) {
      byKey.set(key, { ...l, id: l.id || `l-${key}` });
      return;
    }
    if (l.source === "manual") {
      byKey.set(key, { ...prevLink, ...l, source: "manual", id: prevLink.id || l.id });
      return;
    }
    if (prevLink.source === "file") return;
    byKey.set(key, { ...prevLink, ...l, id: prevLink.id || l.id });
  };
  for (const l of [...file?.links ?? [], ...discovered.links, ...manual.links]) {
    putLink(l);
  }
  return { nodes: [...nodeById.values()], links: [...byKey.values()], updatedAt: Date.now() };
}

// src/main/core/topology/fromNeighbors.ts
var INTF_RE = /^(GE|Eth|GigabitEthernet|XGE|Eth-Trunk|LoopBack|Vlanif|MEth)\S*$/i;
var HEADER_RE = /Local Intf|System Name|Neighbor Dev|Neighbor Intf|Exptime|^[-=+\s]+$/;
function parseLldpNeighbors(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (HEADER_RE.test(line)) continue;
    const cells = line.split(/\s{2,}|\t+/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const localIntf = cells[0];
    if (!INTF_RE.test(localIntf)) continue;
    const rest = cells.slice(1);
    const intfIdx = rest.findIndex((c) => INTF_RE.test(c));
    let neighborName;
    let neighborIntf;
    if (intfIdx >= 1) {
      neighborName = rest.slice(0, intfIdx).join(" ");
      neighborIntf = rest[intfIdx];
    } else if (intfIdx === 0) {
      neighborName = "";
      neighborIntf = rest[0];
    } else {
      neighborName = rest[0] ?? "";
      neighborIntf = rest.length > 1 ? rest[rest.length - 1] : "";
    }
    if (!neighborName) continue;
    out.push({ localIntf, neighborName, neighborIntf });
  }
  return out;
}
async function deriveTopology(probes, opts) {
  const nodes = [];
  const links = [];
  const byName = /* @__PURE__ */ new Map();
  const byId = /* @__PURE__ */ new Map();
  const seenLinks = /* @__PURE__ */ new Set();
  const linkKey2 = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
  for (const p of probes) {
    const node = {
      id: p.id,
      name: p.name,
      role: guessRole(p.name, p.model),
      ...p.model ? { model: p.model } : {},
      deviceId: p.id
    };
    nodes.push(node);
    byId.set(node.id, node);
    byName.set(node.name.toLowerCase(), node);
  }
  for (const p of probes) {
    let result;
    try {
      result = await p.exec("display lldp neighbor", {
        timeoutMs: 8e3,
        ...opts?.signal ? { signal: opts.signal } : {}
      });
    } catch {
      continue;
    }
    if (!result.ok) continue;
    const entries = parseLldpNeighbors(result.clean);
    for (const e of entries) {
      const target = byName.get(e.neighborName.toLowerCase()) ?? (byId.has(`neighbor:${e.neighborName}`) ? byId.get(`neighbor:${e.neighborName}`) : (() => {
        const stub = {
          id: `neighbor:${e.neighborName}`,
          name: e.neighborName,
          role: guessRole(e.neighborName),
          x: Math.random() * 400,
          y: Math.random() * 300
        };
        nodes.push(stub);
        byId.set(stub.id, stub);
        return stub;
      })());
      if (!target) continue;
      if (target.id === p.id) continue;
      const key = linkKey2(p.id, target.id);
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({
        id: `${p.id}->${target.id}:${e.localIntf}-${e.neighborIntf}`,
        from: p.id,
        to: target.id,
        label: `${e.localIntf} \u2194 ${e.neighborIntf}`,
        source: "discovered"
      });
    }
  }
  return { nodes, links, updatedAt: Date.now() };
}

// src/main/core/topology/fromProjectFile.ts
import fs3 from "node:fs";
import { gunzipSync } from "node:zlib";
function decodeText(buf) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf8" };
  } catch {
    return { text: new TextDecoder("gbk").decode(buf), encoding: "gbk" };
  }
}
function decodeTopo(buf) {
  const gzipped = buf.length > 2 && buf[0] === 31 && buf[1] === 139;
  let xml;
  let encoding = "utf8";
  if (gzipped) {
    const d = decodeText(gunzipSync(buf));
    xml = d.text;
    encoding = d.encoding;
  } else if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
    xml = buf.subarray(2).toString("utf16le");
    encoding = "utf16le";
  } else if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) {
    xml = swapBytes(buf.subarray(2)).toString("utf16le");
    encoding = "utf16be";
  } else if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    const d = decodeText(buf.subarray(3));
    xml = d.text;
    encoding = d.encoding;
  } else {
    const d = decodeText(buf);
    xml = d.text;
    encoding = d.encoding;
  }
  return { xml, gzipped, encoding };
}
function swapBytes(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}
var ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/gi;
function parseAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(ATTR_RE)) {
    out[m[1].toLowerCase()] = m[2] ?? "";
  }
  return out;
}
function extractDeviceTags(xml) {
  const devBlock = /<devices[^>]*>([\s\S]*?)<\/devices>/i.exec(xml);
  const source = devBlock ? devBlock[1] : xml.replace(/<interfacePair[\s\S]*?<\/interfacePair>/gi, "");
  const tags = [];
  for (const m of source.matchAll(/<\s*(?:device|dev)\b([^>]*?)\/?\s*>/gi)) {
    tags.push(m[1] ?? "");
  }
  return tags;
}
function parseDevice(attrs) {
  const name = attrs["name"] || attrs["devicename"] || attrs["label"] || attrs["id"] || attrs["devid"] || attrs["uuid"] || "";
  if (!name.trim()) return null;
  const devid = attrs["devid"] || attrs["deviceid"] || attrs["id"] || attrs["uuid"] || void 0;
  const portRaw = attrs["com_port"] || attrs["console"] || attrs["consoleport"] || attrs["porte"] || attrs["port"];
  const port = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  const xRaw = attrs["cx"] ?? attrs["x"];
  const yRaw = attrs["cy"] ?? attrs["y"];
  return {
    name: name.trim(),
    ...attrs["model"] ? { model: attrs["model"] } : {},
    ...Number.isFinite(Number(xRaw)) ? { x: Number(xRaw) } : {},
    ...Number.isFinite(Number(yRaw)) ? { y: Number(yRaw) } : {},
    ...devid ? { devid } : {},
    ...Number.isFinite(port) ? { comPort: port } : {}
  };
}
function extractLinkEndpoints(block) {
  const picks = [];
  const re = /(?:from(?:device|dev|node|name)?|to(?:device|dev|node|name)?|self|other|src(?:device|dev)?id|dst(?:device|dev)?id|dest(?:device|dev)?id|dev(?:ice)?[12]?|node[12]?|endpoint[12]?)="([^"]*)"/gi;
  for (const m of block.matchAll(re)) {
    const v = (m[1] ?? "").trim();
    if (v && !picks.includes(v)) {
      picks.push(v);
      if (picks.length === 2) return [picks[0], picks[1]];
    }
  }
  const cleaned = block.replace(/\blineName\s*=\s*"[^"]*"/gi, "");
  const namePair = cleaned.match(/\bname\s*=\s*"([^"]*)"[\s\S]*?\bname\s*=\s*"([^"]*)"/i);
  if (namePair) {
    const a = (namePair[1] ?? "").trim();
    const b = (namePair[2] ?? "").trim();
    if (a && b && a !== b) return [a, b];
  }
  return null;
}
function extractLineEndpoints(tag) {
  const src = /(?:src|from|source)(?:device|dev)?id\s*=\s*"([^"]*)"/i.exec(tag);
  const dst = /(?:dst|dest|target|to)(?:device|dev)?id\s*=\s*"([^"]*)"/i.exec(tag);
  if (!src || !dst) return null;
  const a = (src[1] ?? "").trim();
  const b = (dst[1] ?? "").trim();
  if (!a || !b || a === b) return null;
  return [a, b];
}
function parseTopoXml(xml) {
  const warnings = [];
  const nodes = [];
  const links = [];
  const idByKey = /* @__PURE__ */ new Map();
  const tags = extractDeviceTags(xml);
  for (const tagAttr of tags) {
    const d = parseDevice(parseAttrs(tagAttr));
    if (!d) continue;
    const id = d.name;
    idByKey.set(id.toLowerCase(), id);
    if (d.devid) idByKey.set(d.devid.toLowerCase(), id);
    nodes.push({
      id,
      name: d.name,
      role: guessRole(d.name, d.model),
      ...d.model ? { model: d.model } : {},
      ...d.comPort ? { deviceId: `127.0.0.1:${d.comPort}` } : {},
      ...d.x !== void 0 ? { x: d.x } : {},
      ...d.y !== void 0 ? { y: d.y } : {}
    });
  }
  if (nodes.length === 0) {
    warnings.push("\u672A\u8BC6\u522B\u5230\u4EFB\u4F55\u8BBE\u5907\u3002\u82E5\u4E3A\u65B0\u7248\u683C\u5F0F\u6216\u538B\u7F29\u53D8\u4F53\uFF0C\u9700\u6309\u771F\u673A .topo \u6837\u4F8B\u6821\u51C6\u89E3\u6790\u5668\u3002");
  }
  const seen = /* @__PURE__ */ new Set();
  const addFileLink = (rawA, rawB) => {
    const a = idByKey.get(rawA.toLowerCase()) ?? rawA;
    const b = idByKey.get(rawB.toLowerCase()) ?? rawB;
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ id: `file-${a}->${b}`, from: a, to: b, source: "file" });
  };
  for (const m of xml.matchAll(/<\s*line\b([^>]*?)\/?\s*>/gi)) {
    const ids = extractLineEndpoints(m[1] ?? "");
    if (ids) addFileLink(ids[0], ids[1]);
  }
  for (const m of xml.matchAll(/<\s*interfacePair\b([^>]*?)(?:\/>|>([\s\S]*?)<\/interfacePair>)/gi)) {
    const pair = extractLinkEndpoints(`${m[1] ?? ""} ${m[2] ?? ""}`);
    if (pair) addFileLink(pair[0], pair[1]);
  }
  return {
    topology: { nodes, links, updatedAt: Date.now() },
    report: { devices: nodes.length, links: links.length, encoding: "xml", gzipped: false, warnings }
  };
}
function readTopoFile(filePath) {
  const decoded = decodeTopo(fs3.readFileSync(filePath));
  const result = parseTopoXml(decoded.xml);
  result.report.gzipped = decoded.gzipped;
  result.report.encoding = decoded.encoding;
  return result;
}

// src/main/tools/device.ts
var scanDevices = {
  name: "scan_devices",
  description: "\u626B\u63CF\u672C\u673A eNSP \u865A\u62DF\u8BBE\u5907\u3002\u53EA\u80FD\u626B\u63CF 127.0.0.1\uFF0C\u7AEF\u53E3\u8303\u56F4\u9ED8\u8BA4 2000-2050\u3002\u8FD4\u56DE\u53D1\u73B0\u7684\u8BBE\u5907\u7AEF\u53E3\u5217\u8868\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    {
      start: typebox_exports.Optional(typebox_exports.Integer({ description: "\u8D77\u59CB\u7AEF\u53E3\uFF0C\u9ED8\u8BA4 2000", default: 2e3 })),
      end: typebox_exports.Optional(typebox_exports.Integer({ description: "\u7ED3\u675F\u7AEF\u53E3\uFF0C\u9ED8\u8BA4 2050", default: 2050 }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const n = result.data?.devices?.length ?? 0;
    return `\u626B\u63CF ${args.start ?? 2e3}-${args.end ?? 2050}\uFF0C\u53D1\u73B0 ${n} \u4E2A\u8BBE\u5907`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const settings2 = ctx.settings;
    const start = clampPort(args.start ?? settings2.scanStart ?? 2e3);
    const end = clampPort(args.end ?? settings2.scanEnd ?? 2050);
    if (end < start) {
      return fail("UNKNOWN", `\u7AEF\u53E3\u8303\u56F4\u975E\u6CD5\uFF1A${start}-${end}`, { ms: Date.now() - t0 });
    }
    const devices = await ctx.sessions.scan(start, end, {
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    return ok(
      {
        devices: devices.map((d) => ({ port: d.port, id: d.id, name: d.name }))
      },
      { ms: Date.now() - t0 }
    );
  }
};
var connectDevice = {
  name: "connect_device",
  description: "\u8FDE\u63A5\u6307\u5B9A\u7AEF\u53E3\u7684 eNSP \u8BBE\u5907\uFF0C\u5EFA\u7ACB\u4F1A\u8BDD\u3002\u8FD4\u56DE\u8BBE\u5907\u578B\u53F7\u3001\u5F53\u524D\u63D0\u793A\u7B26\u4E0E\u89C6\u56FE\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    {
      port: typebox_exports.Integer({ description: "\u8BBE\u5907\u7AEF\u53E3\u53F7\uFF0C\u5982 2008" }),
      name: typebox_exports.Optional(typebox_exports.String({ description: "\u53EF\u9009\uFF0C\u8BBE\u5907\u522B\u540D" }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u8FDE\u63A5 ${d?.name ?? args.port}${d?.model ? `\uFF08${d.model}\uFF09` : ""}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const port = clampPort(args.port);
    try {
      const device = await ctx.sessions.connect(port, args.name);
      return ok(device, { ms: Date.now() - t0, deviceId: device.id });
    } catch (e) {
      return fail("NOT_CONNECTED", e.message, { ms: Date.now() - t0 });
    }
  }
};
var listDevices = {
  name: "list_devices",
  description: "\u5217\u51FA\u5DF2\u77E5\u8BBE\u5907\u53CA\u5176\u8FDE\u63A5\u72B6\u6001\u3001\u578B\u53F7\u3001\u5F53\u524D\u89C6\u56FE\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object({}),
  summarize: (_args, result) => {
    const d = result.data;
    return `\u5DF2\u77E5\u8BBE\u5907 ${d?.devices?.length ?? 0} \u4E2A`;
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now();
    return ok({ devices: ctx.sessions.list() }, { ms: Date.now() - t0 });
  }
};
var disconnectDevice = {
  name: "disconnect_device",
  description: "\u65AD\u5F00\u6307\u5B9A\u8BBE\u5907\u7684\u4F1A\u8BDD\uFF08\u4EC5\u5173\u95ED\u8FDE\u63A5\uFF0C\u4E0D\u4FEE\u6539\u8BBE\u5907\u914D\u7F6E\uFF09\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object(
    { deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID\uFF0C\u5F62\u5982 127.0.0.1:2008" }) },
    { additionalProperties: false }
  ),
  summarize: (args) => `\u65AD\u5F00 ${args.deviceId}`,
  handler: async (args, ctx) => {
    const t0 = Date.now();
    ctx.sessions.disconnect(args.deviceId);
    return ok({ disconnected: args.deviceId }, { ms: Date.now() - t0 });
  }
};
var renameDevice = {
  name: "rename_device",
  description: "\u4E3A\u8BBE\u5907\u8BBE\u7F6E\u522B\u540D\uFF0C\u4FBF\u4E8E\u540E\u7EED\u8BC6\u522B\u3002\u522B\u540D\u4F1A\u88AB\u6301\u4E45\u5316\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    {
      deviceId: typebox_exports.String({ description: "\u8BBE\u5907 ID" }),
      name: typebox_exports.String({ description: "\u65B0\u522B\u540D" })
    },
    { additionalProperties: false }
  ),
  summarize: (args) => `\u91CD\u547D\u540D ${args.deviceId} \u2192 ${args.name}`,
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const d = ctx.sessions.rename(args.deviceId, args.name);
    if (!d) return fail("UNKNOWN", "\u522B\u540D\u4E0D\u80FD\u4E3A\u7A7A", { ms: Date.now() - t0 });
    return ok(d, { ms: Date.now() - t0, deviceId: d.id });
  }
};
function clampPort(p) {
  if (!Number.isFinite(p)) return 2e3;
  return Math.max(1, Math.min(65535, Math.trunc(p)));
}

// src/main/tools/topology.ts
import fs4 from "node:fs";
import path3 from "node:path";
function probesFromSessions(sessions) {
  return sessions.list().filter((d) => d.connected).map((d) => sessions.get(d.id)).filter((s) => !!s).map((s) => ({
    id: s.id,
    name: s.name,
    ...s.model ? { model: s.model } : {},
    exec: (cmd, opts) => s.exec(cmd, opts)
  }));
}
var getTopology = {
  name: "get_topology",
  description: "\u8BFB\u53D6\u5F53\u524D\u7F51\u7EDC\u62D3\u6251\uFF08\u7ED3\u6784\u5316\u6570\u636E\uFF1A\u8BBE\u5907\u8282\u70B9\u3001\u89D2\u8272\u3001\u94FE\u8DEF\u4E0E\u7AEF\u53E3\u6807\u7B7E\uFF09\u3002\u62D3\u6251\u6765\u81EA\u5B9E\u91C7\u63A8\u5BFC\u4E0E\u624B\u52A8\u8865\u753B\u7684\u5408\u5E76\u7ED3\u679C\u3002\u9700\u8981\u4E86\u89E3\u8BBE\u5907\u95F4\u8FDE\u63A5\u5173\u7CFB\u65F6\u5148\u7528\u672C\u5DE5\u5177\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object({}),
  summarize: (_args, result) => {
    const t = result.data;
    return `\u62D3\u6251\uFF1A${t?.nodes?.length ?? 0} \u8282\u70B9 / ${t?.links?.length ?? 0} \u94FE\u8DEF`;
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now();
    const t = ctx.topology.snapshot();
    if (!t.nodes.length && !t.links.length) {
      return ok(
        { ...emptyTopology(), hint: "\u62D3\u6251\u4E3A\u7A7A\uFF0C\u53EF\u7528 refresh_topology \u4ECE\u5DF2\u8FDE\u63A5\u8BBE\u5907\u5B9E\u91C7\u63A8\u5BFC" },
        { ms: Date.now() - t0 }
      );
    }
    return ok(t, { ms: Date.now() - t0 });
  }
};
var refreshTopology = {
  name: "refresh_topology",
  description: "\u5BF9\u5F53\u524D\u5DF2\u8FDE\u63A5\u7684\u8BBE\u5907\u6267\u884C display lldp neighbor \u91CD\u65B0\u63A8\u5BFC\u62D3\u6251\u5E76\u4FDD\u5B58\u3002LLDP \u672A\u5F00\u542F\u7684\u8BBE\u5907\u4F1A\u81EA\u52A8\u8DF3\u8FC7\u3002\u9002\u5408\u8BBE\u5907\u8FDE\u63A5\u60C5\u51B5\u53D8\u5316\u540E\u5237\u65B0\u3002",
  risk: "read",
  scope: "device",
  schema: typebox_exports.Object({}),
  summarize: (_args, result) => {
    const t = result.data;
    return `\u91CD\u63A8\u62D3\u6251\uFF1A${t?.nodes?.length ?? 0} \u8282\u70B9 / ${t?.links?.length ?? 0} \u94FE\u8DEF`;
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now();
    const t = await deriveTopology(probesFromSessions(ctx.sessions), {
      ...ctx.signal ? { signal: ctx.signal } : {}
    });
    ctx.topology.set(t);
    return ok(t, { ms: Date.now() - t0 });
  }
};
var importTopologyFile = {
  name: "import_topology_file",
  description: "\u89E3\u6790 eNSP \u5DE5\u7A0B\u6587\u4EF6\uFF08.topo\uFF09\u4F5C\u4E3A\u62D3\u6251\u7684\u7B2C\u4E00\u6765\u6E90\u5E76\u4FDD\u5B58\uFF1A\u8BBE\u5907\uFF08name/model/\u5750\u6807/com_port\uFF09\u4E0E\u63A5\u53E3\u94FE\u8DEF\u3002\u4E0E LLDP \u5B9E\u91C7\u3001\u753B\u5E03\u624B\u8865\u4E09\u5C42\u964D\u7EA7\u5408\u5E76\uFF0C\u6587\u4EF6\u6700\u6743\u5A01\u3002\u8FD4\u56DE\u62D3\u6251\u4E0E\u89E3\u6790\u7ED3\u6784\u62A5\u544A\uFF08\u8BBE\u5907/\u94FE\u8DEF\u6570\u3001\u8B66\u544A\uFF09\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    { path: typebox_exports.String({ description: ".topo \u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84" }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u5BFC\u5165 ${path3.basename(args.path)}\uFF08${d?.report?.devices ?? 0} \u8BBE\u5907 / ${d?.report?.links ?? 0} \u94FE\u8DEF${d?.report?.warnings?.length ? `\uFF0C${d.report.warnings.length} \u6761\u8B66\u544A` : ""}\uFF09`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const filePath = args.path?.trim() ?? "";
    if (path3.extname(filePath).toLowerCase() !== ".topo") {
      return fail("BAD_PARAM", "\u53EA\u652F\u6301 .topo \u6587\u4EF6", { ms: Date.now() - t0 });
    }
    const resolved = path3.resolve(filePath);
    if (resolved.includes("..")) {
      return fail("BAD_PARAM", "\u8DEF\u5F84\u4E0D\u5141\u8BB8\u5305\u542B ..", { ms: Date.now() - t0 });
    }
    if (!fs4.existsSync(resolved) || !fs4.statSync(resolved).isFile()) {
      return fail("BAD_PARAM", `\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${resolved}`, { ms: Date.now() - t0 });
    }
    try {
      const { topology, report } = readTopoFile(resolved);
      if (report.devices === 0) {
        return fail("UNKNOWN", `\u672A\u80FD\u4ECE .topo \u4E2D\u8BC6\u522B\u8BBE\u5907\uFF08${report.warnings[0] ?? "\u683C\u5F0F\u672A\u77E5"}\uFF09`, { ms: Date.now() - t0 });
      }
      ctx.topology.setFile(topology);
      return ok({ topology, report, path: resolved }, { ms: Date.now() - t0 });
    } catch (e) {
      return fail("UNKNOWN", `\u89E3\u6790 ${path3.basename(resolved)} \u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`, { ms: Date.now() - t0 });
    }
  }
};

// src/main/tools/sessions.ts
import fs5 from "node:fs";
import path4 from "node:path";

// src/main/core/session-tree/report.ts
function buildJson(root, nodes) {
  return JSON.stringify({ root, nodes }, null, 2);
}
function buildMarkdown(root, nodes) {
  const byParent = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  const lines = [];
  lines.push(`# ${root.title}`);
  lines.push(`> \u4F1A\u8BDD ${root.id} \xB7 ${root.nodeCount} \u6761\u6D88\u606F \xB7 \u751F\u6210\u4E8E ${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN")}`);
  lines.push("");
  const emit = (node) => {
    const isRoot = node.parentId === null;
    const children = (byParent.get(node.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    if (node.role === "user") {
      if (!isRoot) lines.push("## \u7528\u6237");
      lines.push(node.content);
      lines.push("");
    } else if (node.role === "assistant") {
      lines.push("## \u4EE3\u7406");
      lines.push(node.content);
      lines.push("");
    } else if (node.role === "tool") {
      const tc = node.toolCall;
      const status = tc ? tc.ok === false ? "\u5931\u8D25" : tc.ok ? "\u6210\u529F" : "\u6267\u884C\u4E2D" : "";
      const ms = tc && tc.ms !== void 0 ? ` \xB7 ${tc.ms}ms` : "";
      lines.push(`> \u5DE5\u5177 **${tc?.name ?? node.content}** ${status}${ms}`);
      lines.push(`> \`${safeJson(tc?.args)}\``);
      lines.push("");
    }
    for (const c of children) emit(c);
  };
  const roots = nodes.filter((n) => n.parentId === null).sort((a, b) => a.createdAt - b.createdAt);
  for (const r of roots) emit(r);
  return lines.join("\n").trimEnd() + "\n";
}
function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// src/main/tools/sessions.ts
function collectSessionReport(store, exportsDir, rootId, format) {
  const meta = store.list().find((m) => m.id === rootId);
  if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF1A${rootId}`);
  const nodes = store.getTree(rootId);
  const body = format === "json" ? buildJson(meta, nodes) : buildMarkdown(meta, nodes);
  const safe = meta.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "session";
  const ext = format === "json" ? "json" : "md";
  const dir = path4.join(exportsDir, safe);
  fs5.mkdirSync(dir, { recursive: true });
  const file = path4.join(dir, `${safe}-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`);
  fs5.writeFileSync(file, body, "utf8");
  return { path: file, ext };
}
var listSessions = {
  name: "list_sessions",
  description: "\u5217\u51FA\u6240\u6709\u4F1A\u8BDD\uFF08\u5386\u53F2\u5BF9\u8BDD\u6811\uFF09\u7684\u6458\u8981\uFF1A\u6807\u9898\u3001\u521B\u5EFA\u65F6\u95F4\u3001\u6700\u8FD1\u6D3B\u52A8\u65F6\u95F4\u3001\u6D88\u606F\u6570\u3002\u7528\u4E8E\u6311\u9009\u8981\u56DE\u6EAF\u6216\u5BFC\u51FA\u7684\u4F1A\u8BDD\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object({}),
  summarize: (_args, result) => {
    const d = result.data;
    return `\u4F1A\u8BDD ${d?.sessions?.length ?? 0} \u4E2A`;
  },
  handler: async (_args, ctx) => {
    const t0 = Date.now();
    return ok({ sessions: ctx.sessionTree.list() }, { ms: Date.now() - t0 });
  }
};
var exportSessionReport = {
  name: "export_session_report",
  description: "\u628A\u6307\u5B9A\u4F1A\u8BDD\u5BFC\u51FA\u4E3A\u62A5\u544A\u6587\u4EF6\uFF08markdown \u6216 json\uFF09\uFF0C\u5199\u5165\u5E94\u7528\u5BFC\u51FA\u76EE\u5F55\uFF0C\u8FD4\u56DE\u6587\u4EF6\u8DEF\u5F84\u3002\u5148 list_sessions \u62FF\u5230 rootId\u3002",
  risk: "read",
  scope: "local",
  schema: typebox_exports.Object(
    {
      rootId: typebox_exports.String({ description: "\u4F1A\u8BDD ID\uFF08list_sessions \u8FD4\u56DE\u7684\u6839\u8282\u70B9 id\uFF09" }),
      format: typebox_exports.Optional(typebox_exports.Union([typebox_exports.Literal("md"), typebox_exports.Literal("json")]))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data;
    return `\u5BFC\u51FA ${args.rootId} \u2192 ${d?.path ?? "\u5931\u8D25"}`;
  },
  handler: async (args, ctx) => {
    const t0 = Date.now();
    const format = args.format === "json" ? "json" : "md";
    try {
      const { path: filePath } = collectSessionReport(ctx.sessionTree, ctx.exportsDir, args.rootId, format);
      return ok({ path: filePath }, { ms: Date.now() - t0 });
    } catch (e) {
      return fail("UNKNOWN", e instanceof Error ? e.message : String(e), { ms: Date.now() - t0 });
    }
  }
};

// src/main/tools/index.ts
var TOOLS = [
  scanDevices,
  connectDevice,
  listDevices,
  disconnectDevice,
  renameDevice,
  getDeviceContext,
  runShowCommand,
  saveConfigSnapshot,
  listSnapshots,
  diffWithSnapshot,
  applyConfig,
  verifyExpectation,
  restoreSnapshot,
  saveConfiguration,
  getTopology,
  refreshTopology,
  importTopologyFile,
  listSessions,
  exportSessionReport
];

// src/main/core/session-tree/store.ts
import fs6 from "node:fs";
import path5 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var SessionTreeStore = class {
  constructor(opts) {
    this.opts = opts;
    fs6.mkdirSync(opts.dir, { recursive: true });
    this.loadIndex();
  }
  index = /* @__PURE__ */ new Map();
  /** rootId → 已加载的节点数组（惰性） */
  cache = /* @__PURE__ */ new Map();
  /** nodeId → rootId（追加时定位所属会话） */
  owner = /* @__PURE__ */ new Map();
  indexFile() {
    return path5.join(this.opts.dir, "sessions-index.json");
  }
  treeFile(rootId) {
    return path5.join(this.opts.dir, `tree-${rootId}.jsonl`);
  }
  loadIndex() {
    try {
      const raw = JSON.parse(fs6.readFileSync(this.indexFile(), "utf8"));
      const sessions = raw?.sessions ?? {};
      for (const m of Object.values(sessions)) {
        if (m && typeof m.id === "string") this.index.set(m.id, m);
      }
    } catch {
      this.index.clear();
    }
  }
  persistIndex() {
    const data = { version: 1, sessions: Object.fromEntries(this.index) };
    const tmp = `${this.indexFile()}.tmp`;
    fs6.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs6.renameSync(tmp, this.indexFile());
  }
  notify() {
    this.opts.onChange?.(this.list());
  }
  parseTree(rootId) {
    const nodes = [];
    try {
      if (fs6.existsSync(this.treeFile(rootId))) {
        const lines = fs6.readFileSync(this.treeFile(rootId), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const node = JSON.parse(line);
            if (node && typeof node.id === "string") {
              nodes.push(node);
              this.owner.set(node.id, rootId);
            }
          } catch {
          }
        }
      }
    } catch {
    }
    this.cache.set(rootId, nodes);
  }
  tree(rootId) {
    if (!this.cache.has(rootId)) this.parseTree(rootId);
    return this.cache.get(rootId) ?? [];
  }
  appendLine(rootId, node) {
    const file = this.treeFile(rootId);
    fs6.mkdirSync(path5.dirname(file), { recursive: true });
    fs6.appendFileSync(file, `${JSON.stringify(node)}
`, "utf8");
  }
  // ———————————————————— 写 ————————————————————
  /** 新建会话：root 节点（role=user，内容=标题） */
  createRoot(title) {
    const root = {
      id: `s-${randomUUID2().slice(0, 8)}`,
      parentId: null,
      role: "user",
      content: title,
      title,
      createdAt: Date.now()
    };
    const meta = {
      id: root.id,
      title,
      createdAt: root.createdAt,
      updatedAt: root.createdAt,
      nodeCount: 1
    };
    this.index.set(root.id, meta);
    this.cache.set(root.id, [root]);
    this.owner.set(root.id, root.id);
    this.persistIndex();
    this.appendLine(root.id, root);
    this.notify();
    return root;
  }
  /** 在指定父节点下追加一条消息节点 */
  append(parentId, node) {
    const rootId = this.owner.get(parentId);
    if (!rootId) throw new Error(`\u672A\u77E5\u7236\u8282\u70B9\uFF1A${parentId}`);
    const full = {
      id: node.id,
      parentId,
      role: node.role,
      content: node.content,
      ...node.toolCall ? { toolCall: node.toolCall } : {},
      createdAt: node.createdAt ?? Date.now()
    };
    this.tree(rootId).push(full);
    this.owner.set(full.id, rootId);
    const meta = this.index.get(rootId);
    if (meta) {
      meta.updatedAt = full.createdAt;
      meta.nodeCount += 1;
      this.persistIndex();
    }
    this.appendLine(rootId, full);
    this.notify();
    return full;
  }
  // ———————————————————— 读 ————————————————————
  /** 会话摘要列表，按 updatedAt 降序 */
  list() {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  getById(nodeId) {
    const rootId = this.owner.get(nodeId);
    if (!rootId) return void 0;
    return this.tree(rootId).find((n) => n.id === nodeId);
  }
  getTree(rootId) {
    return [...this.tree(rootId)];
  }
  /** 从 nodeId 到 root 的祖先链（含 nodeId 自身，根在前） */
  pathTo(rootId, nodeId) {
    const tree = this.tree(rootId);
    const byId = new Map(tree.map((n) => [n.id, n]));
    const path6 = [];
    let cur = byId.get(nodeId);
    while (cur) {
      path6.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : void 0;
    }
    return path6;
  }
  childrenOf(rootId, nodeId) {
    return this.tree(rootId).filter((n) => n.parentId === nodeId);
  }
};

// src/main/agent/react.runtime.ts
function extractPlan(text) {
  const steps = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^(?:\d+[.、)]|[-*])\s+(.{2,80})$/.exec(line);
    if (m) steps.push(m[1].trim());
  }
  return steps.slice(0, 8);
}
function historyToMessages(history) {
  const out = [];
  for (const n of history) {
    if (n.role === "user") {
      out.push({ role: "user", content: n.content, timestamp: n.createdAt });
    } else if (n.role === "assistant") {
      const text = { type: "text", text: n.content };
      out.push({
        role: "assistant",
        content: [text],
        api: "openai-completions",
        provider: "compat",
        model: "history",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: n.createdAt
      });
    } else if (n.role === "tool") {
      const tc = n.toolCall;
      const probe = tc ? `${tc.name}(${safeArgTip(tc.args)}) \u2192 ${tc.ok === false ? "\u5931\u8D25" : "\u5B8C\u6210"}` : n.content;
      out.push({
        role: "user",
        content: `[\u5386\u53F2\u5DE5\u5177\u8C03\u7528 ${probe}]`,
        timestamp: n.createdAt
      });
    }
  }
  return out;
}
function safeArgTip(args) {
  try {
    const s = JSON.stringify(args);
    return s && s.length > 120 ? `${s.slice(0, 120)}\u2026` : s ?? "";
  } catch {
    return String(args);
  }
}
function appendQueuedUserMessages(messages, queued, timestamp) {
  let n = 0;
  const ts = timestamp ?? Date.now();
  for (const t of queued) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    messages.push({ role: "user", content: trimmed, timestamp: ts });
    n += 1;
  }
  return n;
}

// src/main/mcp/server.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import {
  createServer
} from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
async function createMcpServer(opts) {
  const { deps, port } = opts;
  const toolMap = new Map(deps.tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: "ensp-auto", version: "0.4.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.tools.filter((s) => s.risk !== "danger").map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.schema
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const spec = toolMap.get(name);
    if (!spec) {
      return {
        content: [{ type: "text", text: `\u672A\u77E5\u5DE5\u5177\uFF1A${name}` }],
        isError: true
      };
    }
    const signal = new AbortController().signal;
    const ctx = {
      ...deps.buildContext(signal),
      signal,
      requestGate: async () => false
    };
    try {
      const result = await spec.handler(args ?? {}, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.ok
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true
      };
    }
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID3()
  });
  await server.connect(transport);
  const httpServer = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Mcp-Session-Id,Authorization"
      });
      res.end();
      return;
    }
    void transport.handleRequest(req, res, void 0).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("internal error");
      }
    });
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", (e) => reject(e));
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const actualPort = httpServer.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/mcp`,
    close: async () => {
      await transport.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  };
}
export {
  AUTH_RE,
  CONFIRM_RE,
  ChangeStore,
  DANGEROUS_COMMANDS,
  DEFAULT_TELNET_OPTIONS,
  DeviceSession,
  ERROR_PATTERNS,
  PAGING_TAIL_RE,
  STANZA_HEADER_RE,
  SessionTreeStore,
  SnapshotStore,
  TOOLS,
  TelnetClient,
  appendQueuedUserMessages,
  applyBackspaces,
  applyConfig,
  buildJson,
  buildMarkdown,
  checkExpectation,
  classifyDanger,
  cleanResponse,
  compressBlankLines,
  consumeEvent,
  createMcpServer,
  decode,
  decodeTopo,
  deriveTopology,
  detectEncoding,
  detectEncodingDetailed,
  detectError,
  diffLines,
  emptyTopology,
  extractPlan,
  extractView,
  genRollbackCommands,
  guessRole,
  hasCaretMarker,
  hasWarning,
  historyToMessages,
  invertCommand,
  isReadOnlyCommand,
  matchPromptTail,
  mergeLayers,
  mergeTopology,
  newTurn,
  normalizeNewlines,
  parseConfigStanzas,
  parseInterfaces,
  parseLldpNeighbors,
  parseTopoXml,
  parseVersion,
  probeEncodingSupport,
  readTopoFile,
  removeEchoLine,
  restoreSnapshot,
  saveConfiguration,
  splitTrailingPrompt,
  stripAnsi,
  stripIac,
  stripPagingMarkers,
  tailSlice,
  toLLMTools,
  toMcpTools,
  verifyExpectation,
  viewLabel
};
