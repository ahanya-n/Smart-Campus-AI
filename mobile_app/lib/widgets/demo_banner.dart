import 'package:flutter/material.dart';

/// Small "DEMO DATA" pill for app bars.
class DemoChip extends StatelessWidget {
  const DemoChip({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: scheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        'DEMO DATA',
        style: TextStyle(
          color: scheme.onTertiaryContainer,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

/// Explains that the data on screen is sample data, not official records.
class DemoBanner extends StatelessWidget {
  const DemoBanner({super.key, required this.message, this.onExit});

  final String message;

  /// Shown as "Exit demo" when the user opted into demo mode.
  final VoidCallback? onExit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
      decoration: BoxDecoration(
        color: scheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(Icons.science_outlined, color: scheme.onTertiaryContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Demo Data',
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: scheme.onTertiaryContainer,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  message,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onTertiaryContainer),
                ),
              ],
            ),
          ),
          if (onExit != null)
            TextButton(
              onPressed: onExit,
              style: TextButton.styleFrom(
                  foregroundColor: scheme.onTertiaryContainer),
              child: const Text('Exit demo'),
            ),
        ],
      ),
    );
  }
}
