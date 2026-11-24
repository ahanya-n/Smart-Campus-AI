import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../models/app_user.dart';
import '../services/api_service.dart';
import '../services/auth_controller.dart';

class MoodScreen extends StatefulWidget {
  const MoodScreen({super.key});

  @override
  State<MoodScreen> createState() => _MoodScreenState();
}

class _MoodScreenState extends State<MoodScreen> {
  static const _moodLabels = <String, String>{
    'very_low': 'Very low',
    'low': 'Low',
    'neutral': 'Neutral',
    'good': 'Good',
    'very_good': 'Very good',
  };

  late ApiService _api;
  late AuthController _auth;
  String? _authIdentity;
  final _formKey = GlobalKey<FormState>();
  final _reflectionController = TextEditingController();
  String _selectedMood = 'neutral';
  bool _loading = true;
  bool _submitting = false;
  String? _error;
  List<Map<String, dynamic>> _checkIns = [];
  Map<String, dynamic>? _analytics;

  bool get _isStudent => _auth.user?.isStudent == true;
  bool get _canViewAnalytics {
    final user = _auth.user;
    return user?.isFaculty == true || user?.isAdmin == true;
  }

  @override
  void initState() {
    super.initState();
    _auth = AppScope.read(context).auth;
    _authIdentity = _identityFor(_auth.user);
    _auth.addListener(_handleAuthChange);
    _api = AppScope.read(context).api;
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final scope = AppScope.of(context);
    if (scope.auth != _auth) {
      _auth.removeListener(_handleAuthChange);
      _auth = scope.auth;
      _authIdentity = _identityFor(_auth.user);
      _auth.addListener(_handleAuthChange);
      _api = scope.api;
      _resetForAccountChange();
      WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    }
  }

  @override
  void dispose() {
    _auth.removeListener(_handleAuthChange);
    _reflectionController.dispose();
    super.dispose();
  }

  String? _identityFor(AppUser? user) =>
      user == null ? null : '${user.email}\u0000${user.role}';

  void _handleAuthChange() {
    if (!mounted) return;
    final identity = _identityFor(_auth.user);
    if (identity == _authIdentity) return;
    _authIdentity = identity;
    setState(_resetForAccountChange);
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  void _resetForAccountChange() {
    _loading = true;
    _submitting = false;
    _error = null;
    _checkIns = [];
    _analytics = null;
    _reflectionController.clear();
  }

  Future<void> _load() async {
    final identity = _authIdentity;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (_isStudent) {
        final checkIns = await _api.getMyMoodCheckIns();
        if (identity == _authIdentity) _checkIns = checkIns;
      } else if (_canViewAnalytics) {
        final analytics = await _api.getMoodAnalytics();
        if (identity == _authIdentity) _analytics = analytics;
      }
    } on ApiException catch (error) {
      if (identity == _authIdentity) _error = error.message;
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _submitCheckIn() async {
    if (!_isStudent || !_formKey.currentState!.validate() || _submitting) {
      return;
    }
    final identity = _authIdentity;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await _api.createMoodCheckIn(
        _selectedMood,
        reflection: _reflectionController.text,
      );
      if (!mounted || identity != _authIdentity || !_isStudent) return;
      _reflectionController.clear();
      await _load();
    } on ApiException catch (error) {
      if (mounted && identity == _authIdentity) {
        setState(() => _error = error.message);
      }
    } finally {
      if (mounted && identity == _authIdentity) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Mood and wellbeing')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.privacy_tip_outlined, color: scheme.primary),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Private, non-diagnostic check-ins',
                          style: theme.textTheme.titleMedium,
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Mood check-ins are not a diagnosis or a substitute for professional care. They are kept separate from assistant conversations and are never sent as chat messages.',
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (_isStudent) ...[
            _buildCheckInForm(theme),
            const SizedBox(height: 12),
            Text(
              'Your private check-in history',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            _buildStudentHistory(theme),
          ] else if (_canViewAnalytics) ...[
            Text(
              'Aggregate wellbeing analytics',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            const Text(
              'Only group aggregates returned by the campus service are shown; individual student entries are not available in this view.',
            ),
            const SizedBox(height: 8),
            _buildAnalytics(theme),
          ] else
            const _StatusCard(
              icon: Icons.lock_outline,
              message: 'Sign in with an authorized campus account to view this space.',
            ),
        ],
      ),
    );
  }

  Widget _buildCheckInForm(ThemeData theme) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('How are you feeling?', style: theme.textTheme.titleSmall),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _selectedMood,
                decoration: const InputDecoration(
                  labelText: 'Select a mood',
                  border: OutlineInputBorder(),
                ),
                items: _moodLabels.entries
                    .map(
                      (entry) => DropdownMenuItem(
                        value: entry.key,
                        child: Text(entry.value),
                      ),
                    )
                    .toList(),
                onChanged: _submitting
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _selectedMood = value);
                        }
                      },
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mood_private_reflection'),
                controller: _reflectionController,
                minLines: 2,
                maxLines: 4,
                maxLength: 2000,
                decoration: const InputDecoration(
                  labelText: 'Optional private reflection',
                  hintText: 'Write a note for yourself (optional)',
                  border: OutlineInputBorder(),
                ),
              ),
              const Text(
                'Reflections are stored with your private check-in and are never sent to assistant chat.',
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: _submitting ? null : _submitCheckIn,
                icon: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.favorite_border),
                label: Text(
                  _submitting ? 'Saving check-in…' : 'Save private check-in',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStudentHistory(ThemeData theme) {
    if (_loading) return const _LoadingCard(label: 'Loading your check-ins…');
    if (_error != null) {
      return _ErrorCard(message: _error!, onRetry: _load);
    }
    if (_checkIns.isEmpty) {
      return const _StatusCard(
        icon: Icons.inbox_outlined,
        message: 'No mood check-ins yet. Your entries will appear here only for you.',
      );
    }
    return Column(
      children: _checkIns.map((entry) {
        final mood = entry['mood']?.toString() ?? '';
        final created = entry['created_at']?.toString() ?? '';
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const CircleAvatar(
                    child: Icon(Icons.favorite_border),
                  ),
                  title: Text(_moodLabels[mood] ?? 'Check-in'),
                  subtitle: Text(_formatDate(created)),
                  trailing: entry['sentiment'] == null
                      ? null
                      : Text(entry['sentiment'].toString()),
                ),
                if (entry['reflection'] case final String reflection)
                  Text('Your private reflection: $reflection'),
                if (entry['support_message'] != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    entry['support_message'].toString(),
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildAnalytics(ThemeData theme) {
    if (_loading) {
      return const _LoadingCard(label: 'Loading aggregate analytics…');
    }
    if (_error != null) {
      return _ErrorCard(message: _error!, onRetry: _load);
    }
    final analytics = _analytics ?? const <String, dynamic>{};
    final groups =
        (analytics['groups'] as List?)?.whereType<Map>().toList() ?? [];
    if (groups.isEmpty) {
      return const _StatusCard(
        icon: Icons.insights_outlined,
        message: 'No aggregate analytics are available yet.',
      );
    }
    final minimum = analytics['minimum_group_size'];
    return Column(
      children: [
        if (analytics['suppressed'] == true)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              'Groups smaller than $minimum people are suppressed by the service.',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ...groups.map((rawGroup) {
          final group = rawGroup.map(
            (key, value) => MapEntry(key.toString(), value),
          );
          final sentimentCounts = group['sentiment_counts'] is Map
              ? (group['sentiment_counts'] as Map)
              : const {};
          final semester = group['semester']?.toString();
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${group['department'] ?? 'Campus'}${semester == null ? '' : ' · Semester $semester'}',
                    style: theme.textTheme.titleSmall,
                  ),
                  const SizedBox(height: 8),
                  Text('Group size: ${group['count'] ?? 0}'),
                  Text('Average score: ${group['average_score'] ?? '—'} / 5'),
                  const SizedBox(height: 4),
                  Text(
                    'Positive: ${sentimentCounts['positive'] ?? 0} · Neutral: ${sentimentCounts['neutral'] ?? 0} · Negative: ${sentimentCounts['negative'] ?? 0}',
                  ),
                ],
              ),
            ),
          );
        }),
      ],
    );
  }

  String _formatDate(String value) {
    final date = DateTime.tryParse(value)?.toLocal();
    if (date == null) return value;
    String twoDigits(int number) => number.toString().padLeft(2, '0');
    return '${date.year}-${twoDigits(date.month)}-${twoDigits(date.day)} ${twoDigits(date.hour)}:${twoDigits(date.minute)}';
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          Icon(icon),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}

class _LoadingCard extends StatelessWidget {
  const _LoadingCard({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 10),
          Text(label),
        ],
      ),
    ),
  );
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(message),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: TextButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ),
        ],
      ),
    ),
  );
}
