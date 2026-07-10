interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[24px] border-2 border-dashed border-soft-border bg-white p-12 text-center">
      {icon && <div className="mb-4 text-4xl">{icon}</div>}
      <h3 className="text-lg font-semibold text-text-dark">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm text-text-dark/60">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
