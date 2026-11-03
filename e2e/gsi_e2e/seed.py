"""The fixture: one organisation unit group set, its groups, and a handful
of organisation units under one district, created through the API.

Layout (the matrix row for the parent is the expected-values oracle):

    parent   -> Alpha            Ok
    child 1  -> Alpha            Ok
    child 2  -> Beta             Ok
    child 3  -> Alpha + Beta     Conflict
    child 4  -> (none)           Missing (the set is compulsory)
    child 5  -> (none)           Missing
    Gamma holds nobody.
"""

from dataclasses import dataclass, field

from .api import generate_uid
from .state import TYPE_GROUP, TYPE_GROUP_SET, TYPE_ORG_UNIT

PREFIX_FIXED = "E2E tool-group-set-manager"
SHORT_PREFIX = "E2E TGSM"
CODE_PREFIX = "E2E_TGSM"
OPENING_DATE = "2020-01-01"
CHILD_COUNT = 5
GROUP_LABELS = ("Alpha", "Beta", "Gamma")

# Which groups each fixture org unit starts in, by label.
SEEDED_MEMBERSHIP = {
    "parent": ("Alpha",),
    "child1": ("Alpha",),
    "child2": ("Beta",),
    "child3": ("Alpha", "Beta"),
    "child4": (),
    "child5": (),
}


@dataclass
class OrgUnit:
    key: str
    id: str
    name: str


@dataclass
class Group:
    label: str
    id: str
    name: str


@dataclass
class Fixture:
    run_id: str
    prefix: str
    set_id: str
    set_name: str
    district_id: str
    parent_level: int
    org_units: dict = field(default_factory=dict)
    groups: dict = field(default_factory=dict)

    def ou(self, key):
        return self.org_units[key]

    def group(self, label):
        return self.groups[label]

    def baseline(self):
        """group id -> the set of org unit ids it held when seeded."""
        members = {g.id: set() for g in self.groups.values()}
        for key, labels in SEEDED_MEMBERSHIP.items():
            for label in labels:
                members[self.group(label).id].add(self.ou(key).id)
        return members


def _choose_district(api):
    """The first child, by name, of the user's first data capture root."""
    me = api.get("me?fields=organisationUnits[id,level]")
    roots = sorted(me["organisationUnits"], key=lambda o: o["level"])
    if not roots:
        raise RuntimeError("the user has no data capture organisation unit")
    root = api.get(f"organisationUnits/{roots[0]['id']}?fields=children[id,name,level]")
    children = sorted(root.get("children", []), key=lambda o: o["name"])
    if not children:
        raise RuntimeError("the user's root organisation unit has no children")
    return children[0]["id"], children[0]["level"]


def _plan(run_id, district_id, parent_level):
    prefix = f"{PREFIX_FIXED} {run_id}"
    fixture = Fixture(
        run_id=run_id,
        prefix=prefix,
        set_id=generate_uid(),
        set_name=f"{prefix} Set",
        district_id=district_id,
        parent_level=parent_level,
    )
    fixture.org_units["parent"] = OrgUnit("parent", generate_uid(), f"{prefix} Parent")
    for n in range(1, CHILD_COUNT + 1):
        key = f"child{n}"
        fixture.org_units[key] = OrgUnit(key, generate_uid(), f"{prefix} Child {n}")
    for label in GROUP_LABELS:
        fixture.groups[label] = Group(label, generate_uid(), f"{prefix} {label}")
    return fixture


def _short(fixture, suffix):
    return f"{SHORT_PREFIX} {fixture.run_id} {suffix}"[:50]


def _code(fixture, suffix):
    return f"{CODE_PREFIX}_{fixture.run_id}_{suffix}".upper()[:50]


def _org_unit_payload(fixture, ou, parent_id):
    suffix = ou.key.upper()
    return {
        "id": ou.id,
        "name": ou.name,
        "shortName": _short(fixture, ou.key),
        "code": _code(fixture, suffix),
        "openingDate": OPENING_DATE,
        "parent": {"id": parent_id},
    }


def _metadata_payload(fixture):
    parent = fixture.ou("parent")
    org_units = [_org_unit_payload(fixture, parent, fixture.district_id)]
    for key, ou in fixture.org_units.items():
        if key != "parent":
            org_units.append(_org_unit_payload(fixture, ou, parent.id))
    baseline = fixture.baseline()
    groups = [
        {
            "id": g.id,
            "name": g.name,
            "shortName": _short(fixture, g.label),
            "code": _code(fixture, g.label),
            "organisationUnits": [{"id": i} for i in sorted(baseline[g.id])],
        }
        for g in fixture.groups.values()
    ]
    group_set = {
        "id": fixture.set_id,
        "name": fixture.set_name,
        "shortName": _short(fixture, "Set"),
        "code": _code(fixture, "SET"),
        "compulsory": True,
        "dataDimension": True,
        "organisationUnitGroups": [{"id": g.id} for g in fixture.groups.values()],
    }
    return {
        "organisationUnits": org_units,
        "organisationUnitGroups": groups,
        "organisationUnitGroupSets": [group_set],
    }


def _state_entries(fixture):
    entries = [{"type": TYPE_ORG_UNIT, "id": fixture.ou("parent").id, "depth": 1}]
    entries += [
        {"type": TYPE_ORG_UNIT, "id": ou.id, "depth": 2}
        for key, ou in fixture.org_units.items()
        if key != "parent"
    ]
    entries += [{"type": TYPE_GROUP, "id": g.id} for g in fixture.groups.values()]
    entries.append({"type": TYPE_GROUP_SET, "id": fixture.set_id})
    return entries


def read_memberships(api, fixture):
    """group id -> set of org unit ids, as the server holds it now."""
    body = api.get(
        f"organisationUnitGroupSets/{fixture.set_id}"
        "?fields=organisationUnitGroups[id,organisationUnits[id]]"
    )
    return {
        g["id"]: {o["id"] for o in g.get("organisationUnits", [])}
        for g in body["organisationUnitGroups"]
    }


def groups_of(memberships, ou_id):
    """The ids of the groups an org unit is in."""
    return {gid for gid, members in memberships.items() if ou_id in members}


def _verify_seed(api, fixture):
    body = api.get(f"organisationUnitGroupSets/{fixture.set_id}?fields=compulsory,dataDimension")
    if not (body.get("compulsory") and body.get("dataDimension")):
        raise RuntimeError(f"seeded group set reads back wrong: {body}")
    if read_memberships(api, fixture) != fixture.baseline():
        raise RuntimeError("seeded memberships do not read back as created")
    for ou in fixture.org_units.values():
        api.get(f"organisationUnits/{ou.id}?fields=id")


def seed(api, state, run_id):
    district_id, district_level = _choose_district(api)
    fixture = _plan(run_id, district_id, district_level + 1)
    state.add(*_state_entries(fixture))
    report = api.post("metadata?atomicMode=ALL", _metadata_payload(fixture))
    if (report or {}).get("status") not in ("OK", None):
        raise RuntimeError(f"seeding import reported {report.get('status')}: {report}")
    _verify_seed(api, fixture)
    return fixture


def restore_baseline(api, fixture):
    """Puts every group's members back to the seeded state; returns the ids
    of the groups that had to be restored. The safety net after each test,
    so one failed test cannot change the next one's expected values."""
    current = read_memberships(api, fixture)
    restored = []
    for group_id, members in fixture.baseline().items():
        if current.get(group_id) == members:
            continue
        api.patch(
            f"organisationUnitGroups/{group_id}",
            [{"op": "replace", "path": "/organisationUnits", "value": [{"id": i} for i in sorted(members)]}],
        )
        restored.append(group_id)
    return restored


def count_org_units(api):
    body = api.get("organisationUnits?fields=id&pageSize=1")
    return body["pager"]["total"]
