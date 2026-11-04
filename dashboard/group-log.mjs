// The public Hermes groups.log API returns cursor (last event delivered),
// latest_seq (newest stored event) and has_more. Never advance to latest_seq
// until those events have actually been read; that silently skips history.
const isSequence = (value) => Number.isSafeInteger(value) && value >= 0;

export async function readNativeGroupLog(requestPage, {
  since = 0, limit = 200, maxPages = 5,
} = {}) {
  if (typeof requestPage !== "function" || !isSequence(since) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error("Parámetros de sincronización de grupo inválidos.");
  }
  const events = [];
  let cursor = since;
  for (let index = 0; index < maxPages; index++) {
    const page = await requestPage({since_seq: cursor, limit});
    if (!page || !Array.isArray(page.events) ||
        !isSequence(page.cursor) || !isSequence(page.latest_seq) ||
        typeof page.has_more !== "boolean" ||
        page.cursor < cursor || page.cursor > page.latest_seq ||
        (page.has_more && page.cursor >= page.latest_seq)) {
      throw new Error("Respuesta de paginación de grupos inválida.");
    }
    let previous = cursor;
    for (const event of page.events) {
      if (!event || !isSequence(event.seq) || event.seq <= previous ||
          event.seq > page.cursor || !event.event_id) {
        throw new Error("El registro del grupo contiene eventos fuera de orden.");
      }
      previous = event.seq;
    }
    if (page.events.length ? previous !== page.cursor : page.cursor !== cursor) {
      throw new Error("El cursor del grupo no coincide con los eventos recibidos.");
    }
    if (page.has_more && page.cursor === cursor) {
      throw new Error("El registro de grupo no avanza; evitamos un bucle infinito.");
    }
    events.push(...page.events);
    cursor = page.cursor;
    if (!page.has_more) return {events, cursor, has_more:false};
  }
  // The next normal polling tick continues at the actual last-received cursor.
  return {events, cursor, has_more:true};
}
