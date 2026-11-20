import 'package:flutter/material.dart';

/// Describes a feature that has no backend API yet.
class FeaturePreview {
  const FeaturePreview({
    required this.title,
    required this.icon,
    required this.description,
    required this.plannedFeatures,
  });

  final String title;
  final IconData icon;
  final String description;
  final List<String> plannedFeatures;

  static const library = FeaturePreview(
    title: 'Library',
    icon: Icons.local_library_rounded,
    description: 'Search the catalogue and manage your book loans.',
    plannedFeatures: [
      'Book search and availability',
      'Borrowed books and due dates',
      'Renewal requests',
    ],
  );

  static const events = FeaturePreview(
    title: 'Events',
    icon: Icons.event_rounded,
    description: 'Discover what is happening on campus.',
    plannedFeatures: [
      'Upcoming events calendar',
      'Event details and venues',
      'Registration for events',
    ],
  );
}

/// Placeholder for a feature that is not connected to the backend.
/// Deliberately shows no sample data so nothing looks real when it isn't.
class FeaturePreviewScreen extends StatelessWidget {
  const FeaturePreviewScreen({super.key, required this.feature});

  final FeaturePreview feature;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Scaffold(
      appBar: AppBar(title: Text(feature.title)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const SizedBox(height: 12),
          Center(
            child: CircleAvatar(
              radius: 44,
              backgroundColor: scheme.primaryContainer,
              child: Icon(
                feature.icon,
                size: 44,
                color: scheme.onPrimaryContainer,
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text(
            feature.title,
            textAlign: TextAlign.center,
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            feature.description,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyLarge?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 24),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: scheme.tertiaryContainer,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.construction_rounded,
                  color: scheme.onTertiaryContainer,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Preview only. This feature is not connected to the '
                    'Smart Campus backend yet, so no data is shown.',
                    style: TextStyle(color: scheme.onTertiaryContainer),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          Text(
            'Planned features',
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                for (final item in feature.plannedFeatures)
                  ListTile(
                    leading: Icon(
                      Icons.check_circle_outline_rounded,
                      color: scheme.primary,
                    ),
                    title: Text(item),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
