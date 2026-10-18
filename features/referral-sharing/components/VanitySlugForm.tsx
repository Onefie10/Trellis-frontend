'use client';

import React, { useMemo, useState } from 'react';
import { alpha, Box, Button, Chip, TextField, Typography } from '@mui/material';
import {
  CheckCircle as ReadyIcon,
  Link as LinkIcon,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { useReferralStore } from '@/store/referralStore';
import { ReferralService } from '../services/referralService';

interface VanitySlugFormProps {
  userId: string;
}

/**
 * Register a custom vanity referral alias (issue #128).
 *
 * Validation is shared with the service/store, so the browser preview and the
 * backend registry agree on charset, length, reserved words and collisions.
 */
const VanitySlugForm: React.FC<VanitySlugFormProps> = ({ userId }) => {
  const links = useReferralStore((state) => state.links);
  const registerVanitySlug = useReferralStore((state) => state.registerVanitySlug);

  const [slug, setSlug] = useState('');
  const [targetAgentId, setTargetAgentId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const existingSlugs = useMemo(
    () => links.map((link) => link.slug).filter((value): value is string => Boolean(value)),
    [links],
  );

  const validation = useMemo(
    () => ReferralService.validateVanitySlug(slug, existingSlugs),
    [slug, existingSlugs],
  );

  const preview = validation.valid ? ReferralService.buildVanityUrl(validation.normalized) : '';

  const handleSubmit = async () => {
    if (!validation.valid) {
      toast.error(validation.error ?? 'Invalid vanity slug');
      return;
    }
    if (!targetAgentId.trim()) {
      toast.error('Choose the marketplace agent this link should point to');
      return;
    }

    setIsSubmitting(true);
    try {
      const link = await registerVanitySlug({
        userId,
        slug: validation.normalized,
        targetAgentId: targetAgentId.trim(),
      });
      toast.success(`Vanity link ready: ${link.url}`);
      setSlug('');
      setTargetAgentId('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to register vanity link');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box
      component="section"
      sx={{
        p: 3,
        borderRadius: '20px',
        backgroundColor: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.1)',
        mb: 4,
      }}
    >
      <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>
        Custom Vanity Link
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
        Register a clean trellis.market/r/your-name link that points at a specific
        marketplace agent.
      </Typography>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
          mb: 2,
        }}
      >
        <TextField
          label="Vanity slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="alice-agent"
          size="small"
          fullWidth
          error={slug.length > 0 && !validation.valid}
          helperText={
            slug.length > 0 && !validation.valid
              ? validation.error
              : '3-32 characters: letters, numbers and hyphens.'
          }
        />
        <TextField
          label="Marketplace agent"
          value={targetAgentId}
          onChange={(event) => setTargetAgentId(event.target.value)}
          placeholder="agent-id"
          size="small"
          fullWidth
          helperText="The agent this link resolves to."
        />
      </Box>

      {preview && (
        <Chip
          icon={<LinkIcon />}
          label={preview}
          sx={{
            mb: 2,
            backgroundColor: alpha('#4FBF9B', 0.12),
            color: '#4FBF9B',
            fontWeight: 700,
          }}
        />
      )}

      <Button
        variant="contained"
        onClick={handleSubmit}
        disabled={isSubmitting || (slug.length > 0 && !validation.valid)}
        startIcon={<ReadyIcon />}
        sx={{ borderRadius: '12px', textTransform: 'none' }}
      >
        {isSubmitting ? 'Registering...' : 'Register vanity link'}
      </Button>
    </Box>
  );
};

export default VanitySlugForm;
