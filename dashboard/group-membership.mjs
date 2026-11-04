// Pure, testable guard for canonical hosted Hermes rooms.
// Hermes currently has no public groups.members.update method.
const normalize = (members) => [...new Set((members || []).map(String))].sort();
export function isMembershipChanged(previous, desired) {
  return JSON.stringify(normalize(previous)) !== JSON.stringify(normalize(desired));
}
export function assertNativeMembershipEditable(previous, desired, listing, roomId) {
  if (!isMembershipChanged(previous, desired)) return true;
  if (!Array.isArray(listing?.rooms)) {
    throw new Error("No se pudo verificar la sala nativa. No se guardaron los cambios de miembros.");
  }
  if (listing.has_more === true) {
    throw new Error("La lista de salas está incompleta. No se puede verificar la membresía con seguridad.");
  }
  if (listing.rooms.some((room) => room.room_id === roomId)) {
    throw new Error("La membresía de esta sala nativa ya está fijada en Hermes. Creá un grupo nuevo para cambiar los miembros; la configuración no se modificó.");
  }
  return true;
}
