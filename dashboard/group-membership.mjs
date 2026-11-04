// Strict, testable contracts for immutable native Hermes hosted-room membership.
function normalize(members) {
  if (!Array.isArray(members)) throw new Error("Listado de miembros inválido.");
  return [...new Set(members.map(item => {
    const raw = typeof item === "string" ? item : item?.member_id ?? item?.profile;
    const name = String(raw ?? "").trim().toLowerCase();
    if (!name) throw new Error("La sala contiene un miembro sin identidad válida.");
    return name;
  }))].sort();
}

export function isMembershipChanged(previous, desired) {
  return JSON.stringify(normalize(previous)) !== JSON.stringify(normalize(desired));
}

// groups.list returns next_offset, while groups.log uses has_more.
export async function findNativeRoom(roomId, listPage, { limit = 250, maxPages = 40 } = {}) {
  if (!roomId || typeof listPage !== "function") throw new Error("Consulta de grupo inválida.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Límite de salas inválido.");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Límite de páginas inválido.");
  let offset = 0;
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const result = await listPage({ limit, offset });
    if (!Array.isArray(result?.rooms)) throw new Error("Hermes devolvió una lista de salas inválida.");
    const found = result.rooms.find(room => room?.room_id === roomId);
    if (found) return found;
    if (result.next_offset === null) return null;
    const next = result.next_offset;
    if (!Number.isSafeInteger(next) || next <= offset || seen.has(next)) {
      throw new Error("No se pudo verificar la paginación de salas nativas.");
    }
    seen.add(next);
    offset = next;
  }
  throw new Error("La lista de salas es demasiado grande para verificarla de forma segura.");
}

export function assertNativeMembershipEditable(previous, desired, existingRoom) {
  if (!isMembershipChanged(previous, desired)) return true;
  if (existingRoom) {
    throw new Error("La membresía de esta sala nativa ya está fijada en Hermes. Creá un grupo nuevo para cambiar los miembros; la configuración no se modificó.");
  }
  return true;
}

export function assertNativeRoomMembers(configuredMembers, nativeRoom) {
  if (!nativeRoom?.room_id || !Array.isArray(nativeRoom.members) ||
      isMembershipChanged(configuredMembers, nativeRoom.members)) {
    throw new Error("Los miembros de la sala nativa no coinciden con la configuración. No se enviarán mensajes a una membresía inesperada; creá un grupo nuevo.");
  }
  return true;
}
