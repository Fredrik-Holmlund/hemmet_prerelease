/* Vem får ändra vad. Samma regler ska finnas som RLS-policyer i Supabase (supabase/schema.sql),
   så att det inte räcker att fuska i webbläsaren.

   Behörighet går på nivå, inte titel. Guild Master och Guild Leaders är samma nivå, "ledningen":
   att Guild Master har sista ordet är ett mandat, ingen extra knapp på sidan.

   ledningen     skapa, ta bort och återställa grupper, utse och byta Raid Master, ändra allt
   raid master   ändra sin egen grupp: uppgifter, Raid Leader och funktionerna, assignments
   assignments  den som har "Assignments & taktik" i en grupp redigerar gruppens assignment-tavla
   medlem        läsa */

const LEADERSHIP = ["guild_master", "guild_leader"];

export const isLeadership = me => !!me?.guild_roles?.some(r => LEADERSHIP.includes(r));

export const isRaidMasterOf = (me, groupId, assignments) =>
  !!me && assignments.some(a => a.group_id === groupId && a.slot === "raid_master" && a.member_id === me.id);

export const can = {
  createGroup: me => isLeadership(me),
  removeGroup: me => isLeadership(me),     // ta bort (går att ångra), återställa och radera för gott
  editGroup: (me, g, assignments) => isLeadership(me) || isRaidMasterOf(me, g.id, assignments),
  // storlek och Raid Master avgör vem som har ansvaret: bara ledningen
  editStructure: me => isLeadership(me),
  // assignment-tavlan: ledningen, gruppens Raid Master och den som har funktionen "Assignments & taktik"
  editAssignments: (me, g, assignments) => isLeadership(me) || (!!me && assignments.some(a =>
    a.group_id === g.id && a.member_id === me.id && (a.slot === "raid_master" || a.slot === "assignments"))),
  // mallar: alla som får redigera assignments någonstans kan spara och använda dem
  saveTemplate: (me, assignments) => isLeadership(me) || (!!me && assignments.some(a =>
    a.member_id === me.id && (a.slot === "raid_master" || a.slot === "assignments"))),
  // ta bort en mall: den som gjorde den, eller ledningen
  deleteTemplate: (me, t) => isLeadership(me) || (!!me && t.created_by === me.id),
};
