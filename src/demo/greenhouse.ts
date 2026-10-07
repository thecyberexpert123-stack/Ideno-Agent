/**
 * The greenhouse script.
 *
 * Two jobs, one source of truth:
 *
 *  1. It is the executable form of the MVP acceptance scenario — the five-step
 *     conversation from "small autonomous greenhouse" to a recorded decision.
 *     `tests/orchestrator.test.ts` runs it end to end through the real
 *     orchestrator, state manager and versioning, so the acceptance test is not a
 *     claim, it is a test.
 *  2. It powers the UI's clearly-labelled offline demo, so the product can be
 *     evaluated with no provider, no network and no key.
 *
 * The turns are *functions of the current state*, not frozen JSON: like a real
 * model, the script reads the ids that exist and references those. That is what
 * lets turn 3 invalidate an assumption turn 1 created, and turn 5 select an
 * alternative turn 4 proposed.
 *
 * It is a simulation of a competent model, clearly labelled as such wherever it
 * is used. It is never presented as model output.
 */
import type { StateManager } from '../core/state_manager/state_manager.js';
import type { TurnPlanInput } from '../core/schemas/index.js';
import type { CollectionName } from '../core/idea_state/collections.js';
import { allItems, itemLabel } from '../core/idea_state/collections.js';
import type { ScriptedResponder } from '../ai/providers/scripted.js';

export interface DemoLookup {
  /** Id of the first live item in `collection` whose label contains `needle`. */
  findId(collection: CollectionName, needle: string): string | null;
  /** Id of any item (any collection) whose label contains `needle`. */
  findAnyId(needle: string): string | null;
}

export function createLookup(state: StateManager): DemoLookup {
  return {
    findId(collection, needle) {
      const idea = state.idea;
      if (!idea) return null;
      const wanted = needle.toLowerCase();
      const match = (idea[collection] as { id: string }[] & unknown[]).find((item) =>
        itemLabel(collection, item as never).toLowerCase().includes(wanted),
      );
      return (match as { id: string } | undefined)?.id ?? null;
    },
    findAnyId(needle) {
      const idea = state.idea;
      if (!idea) return null;
      const wanted = needle.toLowerCase();
      const located = allItems(idea).find((entry) =>
        itemLabel(entry.collection, entry.item).toLowerCase().includes(wanted),
      );
      return located?.item.id ?? null;
    },
  };
}

const TITLE = 'Small autonomous greenhouse';

export function turnUnderstand(): TurnPlanInput {
  return {
    operation: 'understand',
    classification: 'new_idea',
    reasoning_summary:
      'First structuring pass: restated the goal, recorded three implied requirements and three assumptions, and identified placement and plant set as the blocking unknowns.',
    user_message:
      'I have structured the idea. The goal is a small self-managing greenhouse that keeps plants healthy without daily intervention.\n\n' +
      'That implies three requirements the idea did not state: soil moisture must stay inside a tolerable band, air temperature must stay above the plants\' minimum, and light must be adequate. I have recorded those as assumptions rather than facts: that mains power exists at the site, that a phone or cloud control path is acceptable to you, and that the plants are ordinary temperate herbs rather than tropical species.\n\n' +
      'The two things that actually decide the architecture are where it will sit and what it will grow. Everything else can wait.',
    changes: {
      title: TITLE,
      current_intent:
        'Build a small, self-managing greenhouse that keeps plants healthy with minimal daily intervention.',
      requirements_added: [
        {
          text: 'Keep soil moisture inside a band the plants tolerate, without daily manual watering.',
          provenance: 'model_inferred',
          kind: 'implied',
          priority: 'must',
          affects: { item_ids: [], areas: ['Watering subsystem', 'Sensing'] },
        },
        {
          text: 'Keep air temperature inside the enclosure above the plants\' minimum tolerance.',
          provenance: 'model_inferred',
          kind: 'implied',
          priority: 'must',
          affects: { item_ids: [], areas: ['Enclosure', 'Ventilation'] },
        },
        {
          text: 'Operate for days at a time without the user intervening.',
          provenance: 'user_stated',
          kind: 'explicit',
          priority: 'must',
        },
      ],
      assumptions_added: [
        {
          text: 'Mains electricity is available at the installation site.',
          provenance: 'model_inferred',
          confidence: 0.5,
          if_false_impact: 'high',
          notes: 'If false, the whole power architecture changes.',
        },
        {
          text: 'A cloud or phone-based control path is acceptable.',
          provenance: 'model_inferred',
          confidence: 0.5,
          if_false_impact: 'high',
        },
        {
          text: 'The plants are temperate herbs or seedlings, not tropical species.',
          provenance: 'model_inferred',
          confidence: 0.6,
          if_false_impact: 'medium',
        },
      ],
      constraints_added: [
        {
          text: 'Must be small enough for a domestic setting.',
          provenance: 'model_inferred',
          category: 'physical',
          hard: false,
        },
      ],
      unknowns_added: [
        {
          text: 'Where will it be placed: indoors, on a balcony, or in a garden?',
          provenance: 'unknown',
          impact: 'high',
          affected_areas: ['Enclosure size', 'Environmental exposure', 'Power source'],
        },
        {
          text: 'Which plants, and how many of them?',
          provenance: 'unknown',
          impact: 'high',
          affected_areas: ['Internal volume', 'Water demand', 'Light requirement'],
        },
        {
          text: 'What budget and build skill level is realistic?',
          provenance: 'unknown',
          impact: 'medium',
          affected_areas: ['Control electronics', 'Structure'],
        },
      ],
      research_items_added: [
        {
          question: 'What daily water volume does the target plant set need per pot?',
          priority: 'high',
          rationale: 'Sizes the reservoir, the pump and the refill interval.',
        },
      ],
      open_questions_added: [
        {
          question: 'Where will the greenhouse sit: indoors, on a balcony, or in a garden?',
          target: 'user',
          impact: 'high',
        },
      ],
    },
    question: {
      text: 'Where will the greenhouse sit — indoors, on a balcony, or in a garden?',
      why_it_matters:
        'Placement fixes the weather exposure, the size ceiling and whether mains power exists. Those three decide most of the architecture, so nothing downstream is worth settling first.',
      impact: 'high',
      unknown_id: null,
    },
    followups: [],
  };
}

export function turnBalcony(lookup: DemoLookup): TurnPlanInput {
  const placementUnknown = lookup.findId('unknowns', 'Where will it be placed');
  const domesticConstraint = lookup.findId('constraints', 'small enough for a domestic setting');

  const changes: TurnPlanInput['changes'] = {
    current_intent:
      'Build a small, self-managing greenhouse for a balcony that keeps plants healthy with minimal daily intervention.',
    constraints_added: [
      {
        text: 'Must fit within a balcony footprint and its load limit.',
        provenance: 'user_stated',
        category: 'physical',
        hard: true,
        affects: {
          item_ids: domesticConstraint ? [domesticConstraint] : [],
          areas: ['Enclosure size', 'Structure', 'Water reservoir sizing'],
        },
      },
      {
        text: 'Must withstand outdoor exposure: wind, rain and direct sun.',
        provenance: 'model_inferred',
        category: 'environmental',
        hard: true,
        affects: { item_ids: [], areas: ['Materials', 'Sealing', 'Ventilation'] },
      },
    ],
    unknowns_added: [
      {
        text: 'What are the balcony\'s usable dimensions and load capacity?',
        provenance: 'unknown',
        impact: 'high',
        affected_areas: ['Structure', 'Enclosure size', 'Water reservoir sizing'],
      },
      {
        text: 'Is an outdoor power outlet available on the balcony?',
        provenance: 'unknown',
        impact: 'high',
        affected_areas: ['Power architecture', 'Component selection'],
      },
    ],
  };

  if (placementUnknown) {
    changes.items_updated = [
      {
        id: placementUnknown,
        status: 'resolved',
        resolution: 'The user placed the greenhouse on a balcony.',
      },
    ];
  }
  if (domesticConstraint) {
    changes.items_invalidated = [
      {
        id: domesticConstraint,
        reason: 'Superseded by a precise balcony footprint and load constraint.',
      },
    ];
  }

  return {
    operation: 'update',
    classification: 'new_information',
    reasoning_summary:
      'Balcony placement resolves the siting unknown, replaces the vague domestic-size constraint with a hard footprint and load constraint, and introduces outdoor exposure plus two new blocking unknowns.',
    user_message:
      'Recorded as a hard constraint: it must fit a balcony footprint and its load limit. That replaces my vaguer "small enough for a domestic setting" constraint, which I have marked as superseded.\n\n' +
      'A balcony also means outdoor exposure, so I have added wind, rain and direct sun as an environmental constraint — that changes materials and sealing, not just size. Water is the thing to watch: a full reservoir is the heaviest part of the design, so the load limit caps how much autonomy you can buy with a big tank.\n\n' +
      'Two things now block real progress: the balcony\'s usable dimensions, and whether there is an outdoor outlet. The outlet matters more.',
    changes,
    question: {
      text: 'Does the balcony have an outdoor power outlet you are willing to use?',
      why_it_matters:
        'It decides whether this is a mains-powered controller or a battery-and-solar one. Those differ in component selection, duty cycle, cost and how often you have to touch it — nearly every later decision depends on it.',
      impact: 'high',
      unknown_id: null,
    },
    followups: [],
  };
}

export function turnNoCloud(lookup: DemoLookup): TurnPlanInput {
  const cloudAssumption = lookup.findId('assumptions', 'cloud or phone-based control path');

  const changes: TurnPlanInput['changes'] = {
    constraints_added: [
      {
        text: 'Must operate without cloud connectivity; all control logic runs on the device.',
        provenance: 'user_stated',
        category: 'connectivity',
        hard: true,
        affects: {
          item_ids: cloudAssumption ? [cloudAssumption] : [],
          areas: ['Control architecture', 'Remote monitoring', 'Firmware updates', 'User interface'],
        },
      },
    ],
    requirements_added: [
      {
        text: 'Provide a local way to read status and change settings.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'must',
        affects: { item_ids: [], areas: ['User interface', 'Control architecture'] },
      },
      {
        text: 'Store the watering schedule and configuration on the device so it survives a power loss.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'should',
        affects: { item_ids: [], areas: ['Controller selection', 'Storage'] },
      },
    ],
    findings_added: [
      {
        text:
          'Removing cloud connectivity silently removes two capabilities the design was assuming: remote monitoring and over-the-air firmware updates.',
        kind: 'hidden_dependency',
        severity: 'major',
        provenance: 'model_inferred',
        related_ids: cloudAssumption ? [cloudAssumption] : [],
        recommendation:
          'Choose the local interface (on-device display, Bluetooth, or physical access only) before selecting a controller, because it constrains the chip and the firmware.',
        affects: { item_ids: [], areas: ['Control architecture', 'User interface'] },
      },
    ],
    unknowns_added: [
      {
        text: 'Is short-range local wireless (Bluetooth or LAN) acceptable, or must the device be entirely offline?',
        provenance: 'unknown',
        impact: 'high',
        affected_areas: ['Control architecture', 'User interface', 'Controller selection'],
      },
    ],
    research_items_added: [
      {
        question: 'Which low-power controllers support fully local scheduling plus a local configuration interface?',
        priority: 'medium',
        rationale: 'The no-cloud constraint narrows the controller field considerably.',
      },
    ],
  };

  if (cloudAssumption) {
    changes.items_invalidated = [
      {
        id: cloudAssumption,
        reason: 'The user ruled out cloud connectivity.',
      },
    ];
  }

  return {
    operation: 'update',
    classification: 'revision',
    reasoning_summary:
      'No-cloud is an architectural constraint, not a preference: it invalidates the control-path assumption, removes remote monitoring and OTA updates, and forces a local interface requirement.',
    user_message:
      'That is an architecture change, not a detail, so I have gone back and revised what the idea was resting on.\n\n' +
      'I had assumed a cloud or phone control path was acceptable. That assumption is now marked invalid. Recorded instead as a hard connectivity constraint: all control logic runs on the device.\n\n' +
      'Two things disappear with it that the design was quietly relying on: you lose remote monitoring, and you lose over-the-air firmware updates. I have logged that as a hidden dependency with a recommendation — pick the local interface before picking the controller, because the interface constrains the chip. I have also added a requirement that status and settings must be readable and changeable locally, and that the schedule must survive a power loss.\n\n' +
      'One thing still matters here: "no cloud" and "no wireless" are different constraints.',
    changes,
    question: {
      text: 'Does "no cloud" also rule out local wireless such as Bluetooth, or is phone configuration over Bluetooth acceptable?',
      why_it_matters:
        'It decides whether the device needs a display and buttons or can be configured from a phone over a local link. That is the difference between two controller families and a meaningful cost difference.',
      impact: 'high',
      unknown_id: null,
    },
    followups: [],
  };
}

export function turnAlternatives(lookup: DemoLookup): TurnPlanInput {
  const balconyConstraint = lookup.findId('constraints', 'balcony footprint');
  const noCloudConstraint = lookup.findId('constraints', 'without cloud connectivity');
  const outletUnknown = lookup.findId('unknowns', 'outdoor power outlet');
  const addresses = [balconyConstraint, noCloudConstraint].filter((id): id is string => id !== null);

  return {
    operation: 'explore',
    classification: 'request_alternatives',
    reasoning_summary:
      'Generated three architecturally distinct options along the real axis of variation — how the system gets power and how much it measures — each with a component graph sized for a balcony.',
    user_message:
      'Three genuinely different architectures, and they differ on the axis that actually matters here: how the system gets power, and how much it measures.\n\n' +
      '1. Passive solar with wicking beds — no electronics at all. Cheapest and nothing to debug, but it cannot measure anything or adapt, and autonomy depends on a large reservoir you may not be able to fill on a balcony.\n' +
      '2. Battery-powered sensor node with a local scheduler — measures soil moisture, doses water on demand, runs entirely on device, configurable over Bluetooth. Satisfies every constraint recorded so far, but adds an energy budget that has to be designed around.\n' +
      '3. Mains-powered cabinet controller — the most capable and the simplest to keep alive, but it depends on an outdoor outlet that is still an open unknown.\n\n' +
      'Option 2 is the only one that satisfies both hard constraints without depending on an unanswered question. Option 3 is better if the outlet exists. Option 1 is what to build if you want something working this weekend.',
    changes: {
      alternatives_added: [
        {
          name: 'Passive solar with wicking beds',
          text: 'Passive solar with wicking beds',
          summary:
            'A double-walled translucent enclosure with a raised water reservoir above the plant bed. Water reaches the soil by capillary wicking, so there is no pump and no controller. Temperature is moderated by the thermal mass of the reservoir and a wax-actuated vent that opens on heating without electronics.',
          provenance: 'model_suggestion',
          pros: [
            'No electronics, no firmware, nothing to pair or debug.',
            'Cheapest to build and immune to power loss.',
            'Silent, and safe to leave unattended for weeks.',
          ],
          cons: [
            'Cannot measure anything: no feedback if a wick clogs or the bed dries out.',
            'Watering rate is fixed by wick geometry, so it cannot adapt to weather.',
            'Reservoir must sit above the bed, which costs height on a balcony.',
          ],
          addresses,
          affects: { item_ids: addresses, areas: ['Structure', 'Watering subsystem'] },
          spec: {
            objects: [
              {
                name: 'Enclosure',
                type: 'box',
                dimensions: { width: '600mm', depth: '400mm', height: '450mm' },
                properties: { transparent: true, sealed: false },
                material: 'Twin-wall polycarbonate',
              },
              {
                name: 'Reservoir',
                type: 'box',
                dimensions: { width: '550mm', depth: '120mm', height: '150mm' },
                properties: { capacity: '9 L', sealed: true },
              },
              {
                name: 'Plant bed',
                type: 'box',
                dimensions: { width: '550mm', depth: '350mm', height: '180mm' },
                properties: { pots: 6 },
              },
              { name: 'Wax vent actuator', type: 'custom', dimensions: { stroke: '40mm' }, properties: {}, material: null },
            ],
            connections: [
              { from: 'Reservoir', to: 'Plant bed', kind: 'fluid', label: 'capillary wick' },
              { from: 'Enclosure', to: 'Wax vent actuator', kind: 'mechanical', label: null },
            ],
            constraints: [
              { key: 'electronics', value: false },
              { key: 'sealed', value: false },
              { key: 'reservoir_above_bed', value: true },
            ],
          },
        },
        {
          name: 'Battery-powered sensor node with local scheduler',
          text: 'Battery-powered sensor node with local scheduler',
          summary:
            'A sealed electronics box holds a low-power microcontroller, a soil moisture probe per bed and a small peristaltic pump. The controller runs a local schedule, adjusts dosing from the measured moisture, and keeps configuration in its own flash. A lithium-ion pack with a small solar panel supplies power; configuration happens over Bluetooth from a phone, with no internet path at all.',
          provenance: 'model_suggestion',
          pros: [
            'Measures soil moisture, so it waters on demand instead of on a fixed timer.',
            'Satisfies the no-cloud constraint with no dependency on an outlet.',
            'Local configuration and on-device storage survive power loss.',
            'Small pump and reservoir can be sized to the balcony load limit.',
          ],
          cons: [
            'Introduces an energy budget that must be designed and measured, not assumed.',
            'More parts to fail: pump, probe, battery, charge controller.',
            'Firmware updates need a local path since over-the-air is gone.',
          ],
          addresses,
          affects: { item_ids: addresses, areas: ['Power architecture', 'Control architecture', 'Sensing'] },
          spec: {
            objects: [
              {
                name: 'Enclosure',
                type: 'box',
                dimensions: { width: '600mm', depth: '400mm', height: '400mm' },
                properties: { transparent: true, sealed: false },
                material: 'Twin-wall polycarbonate',
              },
              {
                name: 'Reservoir',
                type: 'cylinder',
                dimensions: { radius: '90mm', height: '220mm' },
                properties: { capacity: '5.6 L', sealed: true },
              },
              {
                name: 'Peristaltic pump',
                type: 'custom',
                dimensions: {},
                properties: { voltage: '6 V', flow_rate: '200 mL/min' },
              },
              {
                name: 'Controller box',
                type: 'box',
                dimensions: { width: '100mm', depth: '60mm', height: '30mm' },
                properties: { sealed: true, wireless: 'bluetooth' },
              },
              { name: 'Soil moisture probe', type: 'tube', dimensions: { length: '120mm' }, properties: {} },
              {
                name: 'Battery pack',
                type: 'box',
                dimensions: { width: '90mm', depth: '60mm', height: '25mm' },
                properties: { chemistry: 'Li-ion', capacity: '20 Wh' },
              },
              {
                name: 'Solar panel',
                type: 'box',
                dimensions: { width: '200mm', depth: '150mm', height: '4mm' },
                properties: { rated_power: '10 W' },
              },
            ],
            connections: [
              { from: 'Reservoir', to: 'Peristaltic pump', kind: 'fluid', label: 'intake' },
              { from: 'Peristaltic pump', to: 'Enclosure', kind: 'fluid', label: 'drip line to bed' },
              { from: 'Soil moisture probe', to: 'Controller box', kind: 'data', label: null },
              { from: 'Controller box', to: 'Peristaltic pump', kind: 'electrical', label: 'drive' },
              { from: 'Battery pack', to: 'Controller box', kind: 'electrical', label: null },
              { from: 'Solar panel', to: 'Battery pack', kind: 'electrical', label: 'charge' },
            ],
            constraints: [
              { key: 'cloud_connectivity', value: false },
              { key: 'local_wireless', value: 'bluetooth' },
              { key: 'sealed_electronics', value: true },
            ],
          },
        },
        {
          name: 'Mains-powered cabinet controller',
          text: 'Mains-powered cabinet controller',
          summary:
            'The same sensing and dosing architecture as option 2, but powered from an outdoor-rated outlet through a sealed low-voltage supply. That removes the energy budget entirely, which allows a fan for heat management, a small local display, and continuous logging.',
          provenance: 'model_suggestion',
          pros: [
            'No energy budget to design around; sensing and actuation can run continuously.',
            'Allows active ventilation and a local display, which the no-cloud constraint makes valuable.',
            'Simplest firmware: no power management or sleep scheduling.',
          ],
          cons: [
            'Depends on an outdoor outlet that is still an open unknown.',
            'Mains wiring outdoors brings an ingress-protection and safety obligation.',
            'Less portable, and cable routing on a balcony is often the ugly part.',
          ],
          addresses,
          affects: {
            item_ids: outletUnknown ? [...addresses, outletUnknown] : addresses,
            areas: ['Power architecture', 'Safety', 'Control architecture'],
          },
          spec: {
            objects: [
              {
                name: 'Enclosure',
                type: 'box',
                dimensions: { width: '600mm', depth: '400mm', height: '400mm' },
                properties: { transparent: true },
                material: 'Twin-wall polycarbonate',
              },
              { name: 'Reservoir', type: 'cylinder', dimensions: { radius: '110mm', height: '250mm' }, properties: { capacity: '9.5 L' } },
              {
                name: 'Peristaltic pump',
                type: 'custom',
                dimensions: {},
                properties: { voltage: '12 V', flow_rate: '300 mL/min' },
              },
              {
                name: 'Controller cabinet',
                type: 'box',
                dimensions: { width: '160mm', depth: '110mm', height: '70mm' },
                properties: { ingress_rating: 'IP65', display: true },
              },
              { name: 'Circulation fan', type: 'cylinder', dimensions: { radius: '40mm', height: '20mm' }, properties: {} },
              { name: 'PSU', type: 'box', dimensions: { width: '120mm', depth: '60mm', height: '40mm' }, properties: { output: '12 V', ingress_rating: 'IP67' } },
            ],
            connections: [
              { from: 'Reservoir', to: 'Peristaltic pump', kind: 'fluid', label: 'intake' },
              { from: 'Peristaltic pump', to: 'Enclosure', kind: 'fluid', label: 'drip line to bed' },
              { from: 'PSU', to: 'Controller cabinet', kind: 'electrical', label: null },
              { from: 'Controller cabinet', to: 'Circulation fan', kind: 'electrical', label: null },
              { from: 'Controller cabinet', to: 'Peristaltic pump', kind: 'electrical', label: 'drive' },
            ],
            constraints: [
              { key: 'requires_outdoor_outlet', value: true },
              { key: 'cloud_connectivity', value: false },
              { key: 'ingress_protection', value: 'IP65' },
            ],
          },
        },
      ],
      research_items_added: [
        {
          question: 'What is the daily energy draw of a moisture-sensing dosing cycle on a low-power controller?',
          priority: 'high',
          rationale:
            'Decides whether the battery-and-solar option meets its autonomy requirement, and it is currently an unverified assumption.',
        },
      ],
      open_questions_added: [
        {
          question: 'Which architecture should the idea commit to?',
          target: 'user',
          impact: 'high',
        },
      ],
    },
    question: null,
    followups: [],
  };
}

export function turnDecision(lookup: DemoLookup): TurnPlanInput {
  const passive = lookup.findId('alternatives', 'Passive solar');
  const battery = lookup.findId('alternatives', 'Battery-powered sensor node');
  const mains = lookup.findId('alternatives', 'Mains-powered cabinet');
  const mainsAssumption = lookup.findId('assumptions', 'Mains electricity is available');
  const outletUnknown = lookup.findId('unknowns', 'outdoor power outlet');
  const considered = [passive, battery, mains].filter((id): id is string => id !== null);

  const changes: TurnPlanInput['changes'] = {
    decisions_added: [
      {
        text: 'Adopt the battery-powered sensor node with a local scheduler as the architecture.',
        rationale: 'Selected by the user from the three proposed architectures.',
        decided_by: 'user',
        alternatives_considered: considered,
        affects: {
          item_ids: battery ? [battery] : [],
          areas: ['Power architecture', 'Control architecture', 'Component selection'],
        },
      },
    ],
    rejected_approaches_added: [
      ...(passive
        ? [
            {
              name: 'Passive solar with wicking beds',
              reason: 'Not selected: it cannot measure soil moisture or adapt dosing to weather.',
              rejected_by: 'user' as const,
              related_alternative_id: passive,
            },
          ]
        : []),
      ...(mains
        ? [
            {
              name: 'Mains-powered cabinet controller',
              reason: 'Not selected: it depends on an outdoor outlet that is not confirmed.',
              rejected_by: 'user' as const,
              related_alternative_id: mains,
            },
          ]
        : []),
    ],
    requirements_added: [
      {
        text: 'Measure soil moisture in each bed and dose water on demand rather than on a fixed timer.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'must',
        affects: { item_ids: [], areas: ['Sensing', 'Watering subsystem'] },
      },
      {
        text: 'Run the whole system from a battery recharged by a small solar panel.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'must',
        affects: { item_ids: [], areas: ['Power architecture'] },
      },
      {
        text: 'Keep configuration on the device so the schedule survives a power loss.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'should',
        affects: { item_ids: [], areas: ['Controller selection', 'Storage'] },
      },
    ],
    unknowns_added: [
      {
        text: 'What runtime between charges does the chosen duty cycle actually give?',
        provenance: 'unknown',
        impact: 'high',
        affected_areas: ['Battery sizing', 'Solar panel sizing', 'Sleep scheduling'],
      },
      {
        text: 'Which specific controller supports local Bluetooth configuration with no cloud dependency?',
        provenance: 'unknown',
        impact: 'medium',
        affected_areas: ['Controller selection', 'Firmware'],
      },
    ],
    research_items_added: [
      {
        question: 'What is the measured average current of a comparable moisture-sensing dosing node over 24 hours?',
        priority: 'high',
        rationale: 'The autonomy requirement cannot be checked without this number.',
      },
    ],
  };

  if (battery) changes.selected_alternative_id = battery;
  if (mainsAssumption) {
    changes.items_invalidated = [
      { id: mainsAssumption, reason: 'The chosen architecture is battery-powered, so mains availability no longer matters.' },
    ];
  }
  if (outletUnknown) {
    changes.items_updated = [
      {
        id: outletUnknown,
        status: 'deferred',
        resolution: 'No longer blocking: the chosen architecture does not use mains power.',
      },
    ];
  }

  return {
    operation: 'decision',
    classification: 'decision',
    reasoning_summary:
      'Recorded the user\'s selection, rejected the other two with their stated reasons, invalidated the mains-power assumption, and deferred the outlet unknown that the decision made moot.',
    user_message:
      'Recorded: the battery-powered sensor node is the architecture. The other two are stored as rejected approaches with reasons, so they stay visible if the energy budget turns out not to work.\n\n' +
      'Two consequences went into the state immediately. The assumption that mains power is available is now invalid — it no longer matters. And the open question about an outdoor outlet is deferred rather than answered, because the decision made it moot.\n\n' +
      'What this commits you to: an energy budget. That is now the single highest-impact unknown in the idea, and it is the one thing that could still send you back to the mains-powered option. I have added a research question for the measured average current of a comparable node, because the autonomy requirement cannot be checked without that number. Next real question after that is which controller supports local Bluetooth configuration with no cloud path.',
    changes,
    question: null,
    followups: [],
  };
}

export function turnScriptFinished(): TurnPlanInput {
  return {
    operation: 'update',
    classification: 'out_of_scope',
    reasoning_summary:
      'The scripted demo covers the five-step acceptance scenario; there is nothing further to replay.',
    user_message:
      'This is the offline demo script, and it covers the five-step scenario: a rough idea, a balcony constraint, the no-cloud revision, three alternative architectures, and your selection of one.\n\n' +
      'To keep developing this idea, switch to a real provider in Settings — Puter.js needs no API key — and Ideno will continue from the state you can see on the right, which is unchanged by the demo ending.',
    changes: {},
    question: null,
    followups: [],
  };
}

/**
 * Builds the responder the ScriptedProvider runs. Each turn is constructed at
 * call time from the live state, so references point at ids that exist.
 */
export function greenhouseResponder(state: StateManager): ScriptedResponder {
  const lookup = createLookup(state);
  const turns = [
    () => turnUnderstand(),
    () => turnBalcony(lookup),
    () => turnNoCloud(lookup),
    () => turnAlternatives(lookup),
    () => turnDecision(lookup),
  ];

  return (_request, index) => {
    const turn = turns[index] ?? (() => turnScriptFinished());
    return { text: JSON.stringify(turn()) };
  };
}

/** The user messages that drive the scripted demo, in order. */
export const DEMO_MESSAGES = [
  'I want to build a small autonomous greenhouse.',
  'It has to fit on a balcony.',
  "I don't want cloud connectivity.",
  'Show me alternative architectures.',
  "Let's use the second one.",
] as const;
