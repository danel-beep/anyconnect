/**
 * Served at /assets/webauthn.js: the only script of the web pages (the CSP allows just our own
 * files). Hand-written ES5-style JavaScript, no bundler.
 *
 * Contract with the pages: a `<form data-passkey="register|authenticate" data-options="URL"
 * action="URL" hidden>` is shown when the browser supports passkeys. On submit, the form fields
 * are POSTed as JSON to `data-options`, the browser ceremony runs with the returned options, and
 * the fields plus `response` are POSTed to `action`. The server answers `{ redirect }` (followed with
 * a full reload, even when only the anchor differs from the current URL), or
 * `{ error, redirect? }` with a 4xx status. Elements with `data-role="passkey-unsupported"` are
 * hidden when passkeys work; `data-role="passkey-error"` shows errors (`data-error` = fallback).
 */
export const WEBAUTHN_JS = String.raw`(function () {
  'use strict';
  if (!window.PublicKeyCredential || !navigator.credentials || !window.fetch) return;

  function toBuffer(value) {
    var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function toBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function descriptors(list) {
    return (list || []).map(function (d) {
      return { type: d.type, id: toBuffer(d.id), transports: d.transports };
    });
  }

  function creationOptions(o) {
    return Object.assign({}, o, {
      challenge: toBuffer(o.challenge),
      user: Object.assign({}, o.user, { id: toBuffer(o.user.id) }),
      excludeCredentials: descriptors(o.excludeCredentials)
    });
  }

  function requestOptions(o) {
    var copy = Object.assign({}, o, { challenge: toBuffer(o.challenge) });
    if (o.allowCredentials) copy.allowCredentials = descriptors(o.allowCredentials);
    return copy;
  }

  function serialize(credential) {
    var r = credential.response;
    var response = { clientDataJSON: toBase64url(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = toBase64url(r.attestationObject);
      if (r.getTransports) response.transports = r.getTransports();
    } else {
      response.authenticatorData = toBase64url(r.authenticatorData);
      response.signature = toBase64url(r.signature);
      if (r.userHandle && r.userHandle.byteLength) response.userHandle = toBase64url(r.userHandle);
    }
    return {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      response: response,
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      authenticatorAttachment: credential.authenticatorAttachment || undefined
    };
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var error = new Error(data.error || '');
        error.redirect = data.redirect;
        throw error;
      });
    });
  }

  function fields(form) {
    var out = {};
    new FormData(form).forEach(function (value, key) {
      if (typeof value === 'string') out[key] = value;
    });
    return out;
  }

  // The server often sends the user back to the page they are on with a new anchor
  // ("/security#pk-..."). Assigning such a URL only scrolls, so the page would keep showing the old
  // list: reload it instead (with the new anchor, so the browser still scrolls to it).
  function go(url) {
    var loc = window.location;
    var here = loc.pathname + loc.search;
    var hash = url.indexOf('#');
    var path = hash < 0 ? url : url.slice(0, hash);
    if (path !== here && path !== loc.href.split('#')[0]) { loc.assign(url); return; }
    if (hash >= 0) loc.hash = url.slice(hash);
    loc.reload();
  }

  function run(form) {
    var mode = form.getAttribute('data-passkey');
    var errorBox = form.querySelector('[data-role=passkey-error]');
    var button = form.querySelector('button[type=submit]');
    var body = fields(form);
    if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
    if (button) button.disabled = true;
    postJson(form.getAttribute('data-options'), body)
      .then(function (options) {
        return mode === 'register'
          ? navigator.credentials.create({ publicKey: creationOptions(options) })
          : navigator.credentials.get({ publicKey: requestOptions(options) });
      })
      .then(function (credential) {
        if (!credential) throw new Error('');
        body.response = serialize(credential);
        return postJson(form.getAttribute('action'), body);
      })
      .then(function (result) {
        go(result.redirect || '/');
      })
      .catch(function (error) {
        if (error && error.redirect) { go(error.redirect); return; }
        if (button) button.disabled = false;
        if (!errorBox) return;
        // Our own errors carry a translated message; browser exceptions (NotAllowedError...) do not.
        var own = error && error.name === 'Error' && error.message;
        errorBox.textContent = own || form.getAttribute('data-error') || '';
        errorBox.hidden = false;
      });
  }

  var hints = document.querySelectorAll('[data-role=passkey-unsupported]');
  for (var h = 0; h < hints.length; h++) hints[h].hidden = true;

  var forms = document.querySelectorAll('form[data-passkey]');
  for (var f = 0; f < forms.length; f++) {
    (function (form) {
      form.hidden = false;
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        run(form);
      });
    })(forms[f]);
  }
})();
`;
