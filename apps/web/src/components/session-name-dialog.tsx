import { useState } from 'react'
import {
	Credenza,
	CredenzaContent,
	CredenzaHeader,
	CredenzaTitle,
	CredenzaDescription,
	CredenzaFooter,
	CredenzaBody
} from '@/components/ui/credenza'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TagIcon } from 'lucide-react'

interface SessionNameDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onName: (name: string) => Promise<void>
}

export function SessionNameDialog({
	open,
	onOpenChange,
	onName
}: SessionNameDialogProps) {
	const [name, setName] = useState('')
	const [saving, setSaving] = useState(false)

	const handleSave = async () => {
		if (!name.trim()) return
		setSaving(true)
		try {
			await onName(name.trim())
			setName('')
			onOpenChange(false)
		} catch {
			// Error handled upstream
		} finally {
			setSaving(false)
		}
	}

	return (
		<Credenza open={open} onOpenChange={onOpenChange}>
			<CredenzaContent className="sm:max-w-sm">
				<CredenzaHeader>
					<CredenzaTitle className="flex items-center gap-2 text-sm">
						<TagIcon className="size-4" />
						Name Session
					</CredenzaTitle>
					<CredenzaDescription className="text-xs">
						Give this conversation a name for easy
						reference.
					</CredenzaDescription>
				</CredenzaHeader>
				<CredenzaBody>
					<Input
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="Session name..."
						onKeyDown={e => {
							if (e.key === 'Enter') handleSave()
						}}
						autoFocus
					/>
				</CredenzaBody>
				<CredenzaFooter>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={!name.trim() || saving}
					>
						{saving ? 'Saving...' : 'Save'}
					</Button>
				</CredenzaFooter>
			</CredenzaContent>
		</Credenza>
	)
}
