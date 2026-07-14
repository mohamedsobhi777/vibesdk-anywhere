import { useMemo, useState } from 'react';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AI_MODEL_CONFIG } from '@/api-types';
import { cn } from '@/lib/utils';

export const DEFAULT_MODEL_OPTION = 'default';

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	'google-ai-studio': 'Google',
	zai: 'Z.ai',
	grok: 'xAI',
	'google-vertex-ai': 'Vertex AI',
};

const PROVIDER_ORDER = ['anthropic', 'openai', 'google-ai-studio', 'zai', 'grok', 'google-vertex-ai'];

interface ModelOption {
	id: string;
	name: string;
	provider: string;
}

interface ProviderGroup {
	provider: string;
	label: string;
	models: ModelOption[];
}

function buildProviderGroups(): ProviderGroup[] {
	const byProvider = new Map<string, ModelOption[]>();
	for (const [id, config] of Object.entries(AI_MODEL_CONFIG)) {
		if (id === 'disabled') continue;
		const group = byProvider.get(config.provider) ?? [];
		group.push({ id, name: config.name, provider: config.provider });
		byProvider.set(config.provider, group);
	}
	return [...byProvider.entries()]
		.sort(([a], [b]) => {
			const ai = PROVIDER_ORDER.indexOf(a);
			const bi = PROVIDER_ORDER.indexOf(b);
			return (ai === -1 ? PROVIDER_ORDER.length : ai) - (bi === -1 ? PROVIDER_ORDER.length : bi);
		})
		.map(([provider, models]) => ({
			provider,
			label: PROVIDER_LABELS[provider] ?? provider,
			models,
		}));
}

interface ModelPickerProps {
	/** Selected AIModels id, or DEFAULT_MODEL_OPTION for platform defaults. */
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	className?: string;
}

/**
 * Compact model dropdown for the home prompt box. Lists every registered
 * model grouped by provider; "Default" keeps the platform's tuned per-action
 * model configuration.
 */
export function ModelPicker({ value, onChange, disabled = false, className }: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const groups = useMemo(buildProviderGroups, []);

	const isDefault = value === DEFAULT_MODEL_OPTION;
	const selectedName = isDefault
		? 'Default model'
		: (AI_MODEL_CONFIG[value as keyof typeof AI_MODEL_CONFIG]?.name ?? value);

	const select = (next: string) => {
		onChange(next);
		setOpen(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					className={cn(
						'relative flex items-center gap-1.5 px-3 py-1.5 text-sm font-normal transition-all duration-200 ease-out',
						disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
						isDefault ? 'text-text-primary/40 hover:text-text-primary/70' : 'text-text-primary',
						className,
					)}
				>
					<Cpu className="size-3" />
					<span className="max-w-36 truncate">{selectedName}</span>
					<ChevronDown className="size-3 opacity-60" />
					{!isDefault && (
						<div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent" />
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-1">
				<div className="max-h-72 overflow-y-auto">
					<button
						type="button"
						onClick={() => select(DEFAULT_MODEL_OPTION)}
						className={cn(
							'flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-bg-3',
							isDefault ? 'text-text-primary' : 'text-text-secondary',
						)}
					>
						<Check className={cn('size-3.5 shrink-0', isDefault ? 'opacity-100' : 'opacity-0')} />
						<span className="font-medium">Default</span>
						<span className="ml-auto text-xs text-text-tertiary">Recommended</span>
					</button>
					{groups.map((group) => (
						<div key={group.provider}>
							<div className="px-2 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
								{group.label}
							</div>
							{group.models.map((model) => {
								const isSelected = value === model.id;
								return (
									<button
										key={model.id}
										type="button"
										onClick={() => select(model.id)}
										className={cn(
											'flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-bg-3',
											isSelected ? 'text-text-primary' : 'text-text-secondary',
										)}
									>
										<Check className={cn('size-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
										<span className="truncate">{model.name}</span>
									</button>
								);
							})}
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
