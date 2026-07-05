/**
 * PRD-011b: active tenancy readout helpers and shell chrome component.
 * Maps daemon truth to honest labels; never fabricates `local · default`.
 */

import React from "react";

import type { SetupTenancyResultWire, WireClient } from "./wire.js";
import { UNREACHABLE_SETUP_TENANCY } from "./wire.js";
import { useScopeSwitcher } from "./scope-context.js";

export type ActiveTenancyLabel =
	| {
			readonly kind: "ok";
			readonly org: string;
			readonly workspace: string;
			/** How the tenancy was confirmed (honeycomb `confirmedBy`); absent on older daemons. */
			readonly confirmedBy?: "selection" | "grandfathered";
	  }
	| { readonly kind: "unavailable" }
	| { readonly kind: "not-linked" }
	| { readonly kind: "not-selected" };

/** Derive the shell readout label from a tenancy read (tv-AC-2/3). */
export function deriveActiveTenancyLabel(read: SetupTenancyResultWire): ActiveTenancyLabel {
	if (read.unreachable) return { kind: "unavailable" };
	if (!read.authenticated) return { kind: "not-linked" };
	if (!read.selected) return { kind: "not-selected" };
	const org = read.org?.name !== "" && read.org?.name !== undefined ? read.org.name : read.org?.id ?? "";
	const workspace =
		read.workspace?.name !== "" && read.workspace?.name !== undefined ? read.workspace.name : read.workspace?.id ?? "";
	if (org === "" || workspace === "") return { kind: "unavailable" };
	return read.confirmedBy !== undefined ? { kind: "ok", org, workspace, confirmedBy: read.confirmedBy } : { kind: "ok", org, workspace };
}

export function formatActiveTenancyLabel(label: ActiveTenancyLabel): string {
	switch (label.kind) {
		case "ok":
			// A grandfathered confirmation (carried forward from a pre-selection credential) is
			// hinted subtly so the operator knows this tenancy was never explicitly picked.
			return label.confirmedBy === "grandfathered" ? `${label.org} · ${label.workspace} (grandfathered)` : `${label.org} · ${label.workspace}`;
		case "unavailable":
			return "tenancy unavailable";
		case "not-linked":
			return "not linked";
		case "not-selected":
			return "tenancy not selected";
		default: {
			const _exhaustive: never = label;
			return _exhaustive;
		}
	}
}

export interface ActiveTenancyDisplayProps {
	readonly wire: WireClient;
	/** Incremented by the shell on honeycomb down→up recovery (tv-AC-4). */
	readonly refreshKey?: number;
}

/** Persistent org · workspace readout for the shell chrome bar (tv-AC-1..5). */
export function ActiveTenancyDisplay({ wire, refreshKey = 0 }: ActiveTenancyDisplayProps): React.JSX.Element {
	const { switchFeedback } = useScopeSwitcher();
	const [tenancy, setTenancy] = React.useState<SetupTenancyResultWire>(UNREACHABLE_SETUP_TENANCY);

	const hydrate = React.useCallback(async (): Promise<void> => {
		setTenancy(await wire.setupTenancy());
	}, [wire]);

	React.useEffect(() => {
		void hydrate();
	}, [hydrate, refreshKey]);

	// tv-AC-5: re-hydrate after a persisted org/workspace switch acknowledges.
	React.useEffect(() => {
		if (switchFeedback?.kind === "persisted" && switchFeedback.pending !== true) {
			void hydrate();
		}
	}, [switchFeedback, hydrate]);

	const label = deriveActiveTenancyLabel(tenancy);
	const text = formatActiveTenancyLabel(label);

	return (
		<span
			data-testid="active-tenancy-display"
			data-tenancy-state={label.kind}
			style={{
				fontFamily: "var(--font-mono)",
				fontSize: "var(--text-xs)",
				color: label.kind === "ok" ? "var(--text-secondary)" : "var(--text-tertiary)",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			}}
		>
			{text}
		</span>
	);
}

/** Tenancy line for the nectar projects panel (tv-AC-6..8). */
export function formatNectarPanelTenancy(
	projectsTenancy: { org?: string; workspace?: string } | undefined,
	fleetTenancy: ActiveTenancyLabel,
): string | null {
	if (projectsTenancy?.org !== undefined && projectsTenancy.org !== "" && projectsTenancy.workspace !== undefined && projectsTenancy.workspace !== "") {
		return `${projectsTenancy.org} · ${projectsTenancy.workspace}`;
	}
	if (fleetTenancy.kind === "ok") {
		return `${fleetTenancy.org} · ${fleetTenancy.workspace} (fleet credential)`;
	}
	if (fleetTenancy.kind === "unavailable") return "tenancy unknown";
	if (fleetTenancy.kind === "not-linked") return "not linked";
	if (fleetTenancy.kind === "not-selected") return "tenancy not selected";
	return "tenancy unknown";
}
