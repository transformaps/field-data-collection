import React from 'react';
import { StyleSheet, View, Button, Text } from 'react-native';

class AddSurveyScreen extends React.Component {
  constructor () {
    super();
  }

  render () {
    const { navigate } = this.props.navigation;

    return (
      <View>
        <Text>
        This is the screen for loading a survey
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({});

export default AddSurveyScreen;
