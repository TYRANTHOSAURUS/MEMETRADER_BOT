interface PanelBoxProps {
  title: string
  children: React.ReactNode
  className?: string
  action?: React.ReactNode
}

export default function PanelBox({ title, children, className = '', action }: PanelBoxProps) {
  return (
    <div className={`panel flex flex-col ${className}`}>
      <div className="panel-title flex items-center justify-between">
        <span>{title}</span>
        {action}
      </div>
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
