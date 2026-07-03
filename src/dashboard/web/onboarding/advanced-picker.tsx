/**
 * The ADVANCED product picker, PRD-009b ob-AC-7. Product CARDS with checkboxes, each carrying the
 * product logo and a one-line purpose, a `Recommended` badge on Doctor, and a visible warning when
 * Doctor is deselected. Confirming enters the same guided flow for exactly the chosen products.
 */

import React from "react";

import { Badge, Button } from "../primitives.js";
import type { InstallableProduct } from "./contracts.js";
import { DOCTOR_DESELECT_WARNING, PRODUCT_COPY, productLogoUrl } from "./product-copy.js";

export interface AdvancedPickerProps {
	/** The remaining (not-yet-installed) installable products, in the fixed order (ob-AC-2: never assumed). */
	readonly products: readonly InstallableProduct[];
	readonly assetBase: string;
	/** Called with EXACTLY the checked products, in the fixed order, when the operator confirms. */
	readonly onConfirm: (selected: readonly InstallableProduct[]) => void;
}

/** One product picker card: logo, one-line purpose, `Recommended` badge (Doctor only), a checkbox. */
function PickerCard({
	product,
	checked,
	onToggle,
	assetBase,
}: {
	readonly product: InstallableProduct;
	readonly checked: boolean;
	readonly onToggle: () => void;
	readonly assetBase: string;
}): React.JSX.Element {
	const copy = PRODUCT_COPY[product];
	return (
		<label
			data-testid={`onboarding-picker-item-${product}`}
			data-checked={checked}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 14,
				padding: "14px 16px",
				borderRadius: "var(--radius-lg)",
				border: `1px solid ${checked ? "var(--honey-border)" : "var(--border-default)"}`,
				background: checked ? "var(--honey-subtle)" : "var(--bg-elevated)",
				cursor: "pointer",
				textAlign: "left",
			}}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={onToggle}
				data-testid={`onboarding-picker-checkbox-${product}`}
				style={{ width: 18, height: 18, flex: "none", accentColor: "var(--honey)" }}
			/>
			<img src={productLogoUrl(product, assetBase)} width={32} height={32} alt="" style={{ flex: "none" }} />
			<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-primary)" }}>
						{copy.title}
					</span>
					{copy.recommended && <Badge tone="honey">Recommended</Badge>}
				</div>
				<span style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{copy.headline}</span>
			</div>
		</label>
	);
}

/** ob-AC-7, the Advanced picker. Doctor is pre-checked (recommended) same as every other product. */
export function AdvancedPicker({ products, assetBase, onConfirm }: AdvancedPickerProps): React.JSX.Element {
	const [selected, setSelected] = React.useState<ReadonlySet<InstallableProduct>>(() => new Set(products));

	const toggle = React.useCallback((product: InstallableProduct): void => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(product)) next.delete(product);
			else next.add(product);
			return next;
		});
	}, []);

	const doctorDeselected = products.includes("doctor") && !selected.has("doctor");

	return (
		<div
			data-testid="onboarding-picker"
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				minHeight: "100vh",
				padding: 32,
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, width: "100%", maxWidth: 520 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					<h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
						Pick what you want to install
					</h1>
					<p style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						Everything you skip stays skipped until you come back and choose it.
					</p>
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", textAlign: "left" }}>
					{products.map((product) => (
						<PickerCard key={product} product={product} checked={selected.has(product)} onToggle={() => toggle(product)} assetBase={assetBase} />
					))}
				</div>

				{doctorDeselected && (
					<p
						data-testid="onboarding-picker-doctor-warning"
						style={{
							fontFamily: "var(--font-sans)",
							fontSize: "var(--text-xs)",
							color: "var(--severity-warning)",
							background: "var(--severity-warning-bg)",
							border: "1px solid var(--severity-warning)",
							borderRadius: "var(--radius-md)",
							padding: "10px 14px",
							margin: 0,
							width: "100%",
						}}
					>
						{DOCTOR_DESELECT_WARNING}
					</p>
				)}

				<Button
					variant="primary"
					size="lg"
					data-testid="onboarding-picker-confirm"
					onClick={() => onConfirm(products.filter((p) => selected.has(p)))}
				>
					Continue
				</Button>
			</div>
		</div>
	);
}
