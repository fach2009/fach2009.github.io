/*
 * Señal Chile TV · versión web para la TV onn (navegador Chrome 47).
 *
 * Lo que aprendimos con la página de diagnóstico y que define este diseño:
 *  - El navegador reproduce las señales .m3u8 por su cuenta (<video src>); hls.js NO funciona ahí.
 *  - Las flechas del control mueven un puntero y OK hace clic: la página no recibe las flechas.
 *    Por eso los botones ▲ ▼ van juntos: se deja el puntero encima y se aprieta OK para cambiar.
 *  - VOLVER sí llega a la página (código 461): muestra u oculta el menú.
 *  - JavaScript antiguo (ES5): sin let/const, clases ni async. Hay localStorage.
 */
(function () {
  "use strict";

  var FUENTES = [
    "https://iptv-org.github.io/iptv/countries/cl.m3u",
    "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_chile.m3u8"
  ];
  var CADA_CUANTO_LISTAS_MS = 12 * 3600 * 1000;
  var ESPERA_CONEXION_MS = 30000;   // si una señal no parte en este tiempo, se prueba la siguiente (Mega tarda ~17 s)
  var ESPERA_CORTE_MS = 15000;      // si el video se queda pegado este tiempo, se reconecta
  var OCULTAR_MENU_MS = 7000;

  var canales = window.CANALES || [];
  var video = document.getElementById("video");
  var body = document.body;

  var actual = 0;            // índice del canal
  var lista = [];            // señales del canal en el orden en que se prueban
  var iSenal = 0;            // señal que se está probando
  var estado = "parado";     // conectando | viendo | error
  var intento = 0;           // para ignorar avisos de señales anteriores
  var inicioIntento = 0, ultimoTiempo = -1, avanzado = 0, ultimaVezAvanzo = 0, reconexiones = 0;
  var timerMenu = null, timerInfo = null;

  // ------------------------------------------------------------ utilidades

  function $(id) { return document.getElementById(id); }
  function txt(el, s) { el.innerHTML = ""; el.appendChild(document.createTextNode(s)); }
  function dos(n) { return n < 10 ? "0" + n : "" + n; }
  function hora() { var d = new Date(); return dos(d.getHours()) + ":" + dos(d.getMinutes()); }
  function tieneClase(c) { return (" " + body.className + " ").indexOf(" " + c + " ") >= 0; }
  function ponerClase(c) { if (!tieneClase(c)) { body.className = (body.className + " " + c).replace(/^\s+/, ""); } }
  function quitarClase(c) { body.className = (" " + body.className + " ").replace(" " + c + " ", " ").replace(/^\s+|\s+$/g, ""); }

  function leer(k) { try { return window.localStorage.getItem("sc_" + k); } catch (e) { return null; } }
  function guardar(k, v) { try { window.localStorage.setItem("sc_" + k, v); } catch (e) { /* sin memoria: no pasa nada */ } }
  function leerJSON(k, def) { try { var v = leer(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }

  // ------------------------------------------------------------ registro (para mejorar la app desde el PC)

  var eventos = [], registroActivo = true, fallasRegistro = 0;
  function registrar(tipo, datos) {
    if (!registroActivo) { return; }
    datos = datos || {};
    datos.tipo = tipo;
    datos.hora = hora();
    eventos.push(datos);
    if (eventos.length > 60) { eventos.shift(); }
  }
  function enviarRegistro() {
    if (!registroActivo || !eventos.length) { return; }
    var lote = eventos; eventos = [];
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/registro", true);
      x.setRequestHeader("Content-Type", "application/json");
      x.onreadystatechange = function () {
        if (x.readyState === 4 && x.status !== 200) {
          fallasRegistro++;
          if (fallasRegistro >= 2) { registroActivo = false; } // publicada en otro lado: no hay a quién avisar
        }
      };
      x.send(JSON.stringify(lote));
    } catch (e) { registroActivo = false; }
  }

  // ------------------------------------------------------------ menú e información

  function mostrarMenu() {
    ponerClase("menu");
    clearTimeout(timerMenu);
    if (estado === "viendo") { timerMenu = setTimeout(ocultarMenu, OCULTAR_MENU_MS); }
  }
  function ocultarMenu() {
    clearTimeout(timerMenu);
    if (estado === "error") { return; }
    quitarClase("menu");
  }
  function destellarInfo() {
    ponerClase("info");
    clearTimeout(timerInfo);
    timerInfo = setTimeout(function () { quitarClase("info"); }, 5000);
  }

  function pintarLogo(caja, canal) {
    caja.innerHTML = "";
    if (canal.logo) {
      var img = document.createElement("img");
      img.src = canal.logo;
      img.alt = "";
      img.onerror = function () { caja.innerHTML = ""; var s = document.createElement("span"); txt(s, canal.nombre); caja.appendChild(s); };
      caja.appendChild(img);
    } else {
      var s = document.createElement("span"); txt(s, canal.nombre); caja.appendChild(s);
    }
  }

  var tiles = [];
  function crearTiles() {
    var cont = $("tiles");
    for (var i = 0; i < canales.length; i++) {
      var c = canales[i];
      var b = document.createElement("button");
      b.className = "tile";
      var logo = document.createElement("div"); logo.className = "logo"; pintarLogo(logo, c);
      var nom = document.createElement("span"); nom.className = "nombre";
      var num = document.createElement("b"); txt(num, String(c.num));
      nom.appendChild(num); nom.appendChild(document.createTextNode(c.nombre));
      b.appendChild(logo); b.appendChild(nom);
      b.onclick = (function (idx) {
        return function () {
          if (idx === actual && estado === "viendo") { ocultarMenu(); return; }
          cambiarCanal(idx);
        };
      })(i);
      cont.appendChild(b);
      tiles.push(b);
    }
  }

  function pintarActual() {
    for (var i = 0; i < tiles.length; i++) { tiles[i].className = i === actual ? "tile actual" : "tile"; }
    var c = canales[actual];
    pintarLogo($("info").getElementsByTagName("div")[0], c);
    txt($("infoNum"), String(c.num));
    txt($("infoNombre"), c.nombre);
    txt($("infoCalidad"), "");
    txt($("infoNota"), "");
  }

  // ------------------------------------------------------------ orden de las señales de un canal

  function ordenarSenales(c) {
    var r = [], vistas = {};
    // copias: probarSenal marca las señales (expandida) y no debe tocar la lista original del canal
    function agregar(s) { if (s && s.url && !vistas[s.url]) { vistas[s.url] = true; r.push({ url: s.url, nota: s.nota, ok: s.ok }); } }
    var ultimaBuena = leer("ok_" + c.num);
    var extra = leerJSON("extra_" + c.num, []);
    var i;
    if (ultimaBuena) {
      for (i = 0; i < c.senales.length; i++) { if (c.senales[i].url === ultimaBuena) { agregar(c.senales[i]); } }
      for (i = 0; i < extra.length; i++) { if (extra[i] === ultimaBuena) { agregar({ url: extra[i] }); } }
    }
    for (i = 0; i < c.senales.length; i++) { if (c.senales[i].ok && !c.senales[i].nota) { agregar(c.senales[i]); } }
    for (i = 0; i < extra.length; i++) { agregar({ url: extra[i] }); }                 // nuevas de las listas
    for (i = 0; i < c.senales.length; i++) { if (c.senales[i].ok) { agregar(c.senales[i]); } } // reemplazos (con nota)
    for (i = 0; i < c.senales.length; i++) { agregar(c.senales[i]); }                  // las que estaban caídas
    return r;
  }

  // ------------------------------------------------------------ reproducción

  function cambiarCanal(i) {
    var n = canales.length;
    actual = ((i % n) + n) % n;
    guardar("canal", String(actual));
    pintarActual();
    destellarInfo();
    lista = ordenarSenales(canales[actual]);
    reconexiones = 0;
    probarSenal(0);
    registrar("canal", { canal: canales[actual].nombre });
  }

  function probarSenal(k) {
    var c = canales[actual];
    iSenal = k;
    intento++;
    estado = "conectando";
    quitarClase("error");
    ponerClase("cargando");
    var s = lista[k];
    txt($("cargandoTxt"), "Conectando con " + c.nombre + "…" +
      (k > 0 ? "  (señal " + (k + 1) + " de " + lista.length + (s.alto ? ", " + s.alto + "p" : "") + ")" : ""));
    txt($("infoNota"), s.nota ? "· " + s.nota : "");
    inicioIntento = Date.now();
    ultimoTiempo = -1;
    avanzado = 0;
    ultimaVezAvanzo = Date.now();
    try { video.pause(); } catch (e) { /* nada */ }
    if (c.calidadMax && !s.fija && !s.expandida) {
      video.removeAttribute("src"); // que no siga el canal anterior mientras se leen las calidades
      try { video.load(); } catch (e) { /* nada */ }
      expandirVariantes(k);
      return;
    }
    video.src = s.url;
    try { video.load(); } catch (e) { /* nada */ }
    reproducirVideo();
  }

  /*
   * Calidad fija (canales con "calidadMax", por ahora Chilevisión): el reproductor de la TV falla
   * (error 3, al decodificar) cuando la señal cambia sola de calidad. Se lee la lista de calidades
   * justo antes de ver el canal (los enlaces traen una sesión que vence) y se le entrega a la TV una
   * sola calidad: la mejor hasta calidadMax, luego las siguientes más bajas y al final la señal normal.
   */
  function expandirVariantes(k) {
    var s = lista[k], c = canales[actual], esperado = intento, hecho = false;
    s.expandida = true;
    function fin(variantes) {
      if (hecho) { return; }
      hecho = true;
      if (esperado !== intento) { return; } // se cambió de canal mientras tanto
      if (variantes.length) {
        Array.prototype.splice.apply(lista, [k, 0].concat(variantes));
        var altos = [];
        for (var i = 0; i < variantes.length; i++) { altos.push(variantes[i].alto); }
        registrar("calidades", { canal: c.nombre, altos: altos.join(",") });
      } else {
        registrar("calidades", { canal: c.nombre, altos: "ninguna (se usa la señal normal)" });
      }
      probarSenal(k);
    }
    try {
      var x = new XMLHttpRequest();
      x.open("GET", s.url, true);
      x.timeout = 8000;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) { return; }
        fin(x.status === 200 ? elegirVariantes(x.responseText, x.responseURL || s.url, c.calidadMax, s) : []);
      };
      x.send();
    } catch (e) { fin([]); }
  }

  function urlAbsoluta(uri, base) {
    if (/^https?:\/\//i.test(uri)) { return uri; }
    if (uri.charAt(0) === "/") { var m = /^(https?:\/\/[^\/]+)/i.exec(base); return (m ? m[1] : "") + uri; }
    return base.replace(/[?#].*$/, "").replace(/[^\/]*$/, "") + uri;
  }

  function elegirVariantes(texto, base, max, origen) {
    var lineas = texto.split("\n"), r = [], vistos = {};
    for (var i = 0; i < lineas.length; i++) {
      if (lineas[i].indexOf("#EXT-X-STREAM-INF") !== 0) { continue; }
      var m = /RESOLUTION=\d+x(\d+)/.exec(lineas[i]);
      var alto = m ? parseInt(m[1], 10) : 0;
      var j = i + 1;
      while (j < lineas.length && (!lineas[j].replace(/\s+/g, "") || lineas[j].charAt(0) === "#")) { j++; }
      if (j >= lineas.length || !alto || alto > max || vistos[alto]) { continue; }
      vistos[alto] = true;
      r.push({ url: urlAbsoluta(lineas[j].replace(/^\s+|\s+$/g, ""), base), fija: true, alto: alto,
               origen: origen.url, nota: origen.nota });
    }
    r.sort(function (a, b) { return b.alto - a.alto; });
    return r.slice(0, 3);
  }

  function reproducirVideo() {
    try {
      var p = video.play();
      if (p && typeof p.then === "function") { p.then(null, function () { /* se reintenta en el vigilante */ }); }
    } catch (e) { /* nada */ }
  }

  function senalSiguiente(motivo) {
    var c = canales[actual];
    var sf = lista[iSenal] || {};
    registrar("falla", { canal: c.nombre, url: sf.origen || sf.url, calidadFija: sf.alto || null, motivo: motivo,
      segundos: Math.round((Date.now() - inicioIntento) / 1000) });
    if (iSenal + 1 < lista.length) { probarSenal(iSenal + 1); return; }
    estado = "error";
    quitarClase("cargando");
    try { video.pause(); } catch (e) { /* nada */ }
    video.removeAttribute("src");
    try { video.load(); } catch (e) { /* nada */ }
    txt($("errorTitulo"), c.nombre + " sin señal");
    txt($("errorTxt"), "Probamos " + lista.length + (lista.length === 1 ? " enlace" : " enlaces") +
      " y ninguno está transmitiendo ahora. Puedes reintentar o ver otro canal.");
    ponerClase("error");
    mostrarMenu();
  }

  function marcarViendo() {
    estado = "viendo";
    reconexiones = 0;
    quitarClase("cargando");
    var s = lista[iSenal];
    guardar("ok_" + canales[actual].num, s.origen || s.url); // los enlaces de calidad fija vencen: se guarda el original
    registrar("ok", { canal: canales[actual].nombre, senal: iSenal + 1, calidadFija: s.alto || null,
      ms: Date.now() - inicioIntento });
    if (tieneClase("menu")) { mostrarMenu(); } // reinicia el tiempo para ocultarlo
  }

  video.addEventListener("error", function () {
    if (estado !== "conectando" && estado !== "viendo") { return; }
    if (!video.currentSrc || (lista[iSenal] && video.currentSrc !== lista[iSenal].url)) { return; } // sin enlace o aviso de uno anterior
    var cod = video.error ? video.error.code : 0;
    var esperado = intento;
    // pequeño respiro: a veces llega el error del enlace anterior justo al cambiar
    setTimeout(function () { if (esperado === intento) { senalSiguiente("error de video " + cod); } }, 300);
  });
  video.addEventListener("waiting", function () { if (estado === "viendo") { ponerClase("cargando"); txt($("cargandoTxt"), "Cargando…"); } });
  video.addEventListener("playing", function () { if (estado === "viendo") { quitarClase("cargando"); } });

  // Vigilante: confirma que el video avanza, cambia de señal si no parte y reconecta si se corta
  setInterval(function () {
    if (estado !== "conectando" && estado !== "viendo") { return; }
    var ahora = Date.now(), t = video.currentTime || 0;
    if (ultimoTiempo >= 0 && t > ultimoTiempo + 0.05) {
      avanzado += Math.min(t - ultimoTiempo, 2);
      ultimaVezAvanzo = ahora;
      if (estado === "viendo") { quitarClase("cargando"); }
    }
    ultimoTiempo = t;
    if (video.videoHeight) { txt($("infoCalidad"), "· " + video.videoHeight + "p"); }

    if (estado === "conectando") {
      if (avanzado >= 1 && video.videoWidth > 0) { marcarViendo(); return; }
      if (video.paused && video.readyState >= 2) { reproducirVideo(); }
      if (ahora - inicioIntento > ESPERA_CONEXION_MS) { senalSiguiente("no partió en " + (ESPERA_CONEXION_MS / 1000) + " s"); }
    } else if (ahora - ultimaVezAvanzo > ESPERA_CORTE_MS) {
      if (reconexiones < 2) {
        reconexiones++;
        registrar("reconexion", { canal: canales[actual].nombre });
        var r = reconexiones;
        probarSenal(iSenal);
        reconexiones = r;
      } else {
        senalSiguiente("se cortó");
      }
    } else if (video.paused) {
      reproducirVideo(); // en vivo nunca debe quedar en pausa
    }
  }, 1000);

  // ------------------------------------------------------------ pantalla completa

  function enPantallaCompleta() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen);
  }
  function pedirPantallaCompleta() {
    var el = document.documentElement;
    try {
      if (el.requestFullscreen) { el.requestFullscreen(); }
      else if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); }
    } catch (e) { /* nada */ }
  }
  function salirPantallaCompleta() {
    try {
      if (document.exitFullscreen) { document.exitFullscreen(); }
      else if (document.webkitExitFullscreen) { document.webkitExitFullscreen(); }
    } catch (e) { /* nada */ }
  }
  function pintarBotonCompleta() {
    txt($("btnCompleta"), enPantallaCompleta() ? "⛶ Salir de pantalla completa" : "⛶ Pantalla completa");
  }
  document.addEventListener("webkitfullscreenchange", pintarBotonCompleta);
  document.addEventListener("fullscreenchange", pintarBotonCompleta);

  // ------------------------------------------------------------ puntero y control remoto

  var yaPidioCompleta = false, ultX = -1, ultY = -1;

  document.addEventListener("mousemove", function (e) {
    if (e.clientX === ultX && e.clientY === ultY) { return; } // algunos punteros avisan sin moverse
    ultX = e.clientX; ultY = e.clientY;
    mostrarMenu();
  });

  // El primer clic pone pantalla completa (el navegador solo lo permite después de un clic)
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!yaPidioCompleta && t !== $("btnCompleta")) {
      yaPidioCompleta = true;
      if (!enPantallaCompleta()) { pedirPantallaCompleta(); }
    }
    if (t !== video) { mostrarMenu(); }
  }, true);

  // Clic sobre la imagen (fuera de los botones): muestra u oculta el menú
  video.addEventListener("click", function () {
    if (tieneClase("menu")) { ocultarMenu(); } else { mostrarMenu(); }
  });

  $("btnMas").onclick = function () { cambiarCanal(actual + 1); };
  $("btnMenos").onclick = function () { cambiarCanal(actual - 1); };
  $("btnReintentar").onclick = function () { lista = ordenarSenales(canales[actual]); probarSenal(0); };
  $("btnOtro").onclick = function () { cambiarCanal(actual + 1); };
  $("btnCompleta").onclick = function () {
    yaPidioCompleta = true;
    if (enPantallaCompleta()) { salirPantallaCompleta(); } else { pedirPantallaCompleta(); }
  };

  var teclasVistas = {};
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode || e.which || 0;
    if (!teclasVistas[k]) { teclasVistas[k] = true; registrar("tecla", { keyCode: k, key: e.key || null }); }
    var hecho = true;
    if (k === 461 || k === 8 || k === 27 || k === 10009) {            // VOLVER
      if (tieneClase("menu") && estado === "viendo") { ocultarMenu(); } else { mostrarMenu(); }
    } else if (k === 38 || k === 33 || k === 427) {                    // ▲ / CH+ (si el navegador las deja pasar)
      cambiarCanal(actual + 1);
    } else if (k === 40 || k === 34 || k === 428) {                    // ▼ / CH−
      cambiarCanal(actual - 1);
    } else if ((k >= 49 && k <= 57) || (k >= 97 && k <= 105)) {        // números 1-9
      var n = (k >= 97 ? k - 96 : k - 48);
      if (n <= canales.length) { cambiarCanal(n - 1); }
    } else {
      hecho = false;
    }
    if (hecho && e.preventDefault) { e.preventDefault(); }
  });

  // ------------------------------------------------------------ enlaces nuevos desde las listas públicas

  function leerM3U(texto) {
    var lineas = texto.split("\n"), r = [], act = null;
    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i].replace(/^\s+|\s+$/g, "");
      if (l.indexOf("#EXTINF") === 0) {
        var id = /tvg-id="([^"]*)"/.exec(l);
        act = { id: id ? id[1] : "", nombre: l.substring(l.lastIndexOf(",") + 1), referer: false };
      } else if (l.indexOf("#EXTVLCOPT") === 0 && act && /http-refer/i.test(l)) {
        act.referer = true;
      } else if (l && l.charAt(0) !== "#" && act) {
        act.url = l; r.push(act); act = null;
      }
    }
    return r;
  }

  function coincide(entrada, canal) {
    for (var i = 0; i < canal.ids.length; i++) {
      var cid = canal.ids[i];
      if (entrada.id === cid || (cid.indexOf("@") < 0 && entrada.id.split("@")[0] === cid)) {
        return !(canal.excluir && new RegExp(canal.excluir, "i").test(entrada.nombre));
      }
    }
    return false;
  }

  function refrescarListas() {
    var ultima = parseInt(leer("listas_fecha") || "0", 10);
    if (Date.now() - ultima < CADA_CUANTO_LISTAS_MS) { return; }
    var pendientes = FUENTES.length, nuevas = {}, algunaBien = false;
    function terminar() {
      if (--pendientes > 0 || !algunaBien) { return; }
      for (var i = 0; i < canales.length; i++) {
        guardar("extra_" + canales[i].num, JSON.stringify(nuevas[canales[i].num] || []));
      }
      guardar("listas_fecha", String(Date.now()));
      registrar("listas", { ok: true });
    }
    for (var f = 0; f < FUENTES.length; f++) {
      (function (url) {
        var x = new XMLHttpRequest();
        x.open("GET", url, true);
        x.timeout = 15000;
        x.onreadystatechange = function () {
          if (x.readyState !== 4) { return; }
          if (x.status === 200) {
            algunaBien = true;
            var entradas = leerM3U(x.responseText);
            for (var i = 0; i < entradas.length; i++) {
              var e = entradas[i];
              if (e.referer) { continue; } // el navegador no puede enviar "referer"
              for (var j = 0; j < canales.length; j++) {
                var c = canales[j];
                if (!coincide(e, c)) { continue; }
                var ya = false;
                for (var s = 0; s < c.senales.length; s++) { if (c.senales[s].url === e.url) { ya = true; } }
                if (!ya) {
                  nuevas[c.num] = nuevas[c.num] || [];
                  if (nuevas[c.num].indexOf(e.url) < 0) { nuevas[c.num].push(e.url); }
                }
              }
            }
          } else {
            registrar("listas", { ok: false, url: url, status: x.status });
          }
          terminar();
        };
        try { x.send(); } catch (err) { terminar(); }
      })(FUENTES[f]);
    }
  }

  // ------------------------------------------------------------ inicio

  function escalar() {
    if (window.innerWidth > 0) {
      document.documentElement.style.fontSize = Math.max(12, Math.round(window.innerWidth / 64)) + "px";
    }
  }
  escalar();
  window.addEventListener("resize", escalar);

  function pintarReloj() { txt($("reloj"), hora()); }
  pintarReloj();
  setInterval(pintarReloj, 10000);
  setInterval(enviarRegistro, 8000);

  if (!canales.length) { txt($("cargandoTxt"), "No hay canales configurados."); ponerClase("cargando"); return; }

  registrar("inicio", { ua: navigator.userAgent, ventana: window.innerWidth + "x" + window.innerHeight });
  crearTiles();
  var guardado = parseInt(leer("canal") || "0", 10);
  cambiarCanal(isNaN(guardado) ? 0 : guardado);
  mostrarMenu();
  setTimeout(refrescarListas, 8000); // después de que parta el primer canal
})();
